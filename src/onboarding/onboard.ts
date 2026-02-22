import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderProfile, RoutingConfig, RoutingTarget, T560Config, TelegramDmPolicy } from "../config/state.js";
import {
  ensureStateDir,
  readConfig,
  readOnboardingStatus,
  resolveRoutingTarget,
  resolveStateDir,
  resolveSoulPath,
  resolveUsersPath,
  resolveUserPath,
  writeConfig
} from "../config/state.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import {
  getProviderCatalogEntry,
  listProviderCatalog,
  type ProviderCatalogEntry
} from "./provider-catalog.js";
import {
  createClackOnboardingPrompter,
  OnboardingCancelledError
} from "./clack-prompter.js";
import { openUrl } from "./browser-open.js";
import { loginOpenAICodexOAuth } from "./openai-codex-oauth.js";
import { isRemoteEnvironment } from "./oauth-env.js";

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

const DEFAULT_SELF_PROTECTED_PATHS = [
  ".",
  "src/cli",
  "dist/cli",
  "cli",
  "src/bin",
  "dist/bin",
  "bin"
];

const DEFAULT_USAGE_TOKEN_BUDGET = 2_000_000;
const DEFAULT_USAGE_COST_BUDGET_USD = 50;

function resolveInstallRootForOnboarding(): string {
  const resolved = resolveOpenClawPackageRootSync({
    cwd: process.cwd(),
    argv1: process.argv[1],
    moduleUrl: import.meta.url
  });
  return resolved ?? process.cwd();
}

function applySelfProtectionDefaults(config: T560Config, installRoot: string): T560Config {
  const existing = config.tools?.selfProtection;
  const protectedPaths = unique(
    [...(existing?.protectedPaths ?? []), ...DEFAULT_SELF_PROTECTED_PATHS]
      .map((entry) => entry.trim())
      .filter(Boolean)
  );

  return {
    ...config,
    tools: {
      ...config.tools,
      selfProtection: {
        enabled: existing?.enabled ?? true,
        installRoot: existing?.installRoot?.trim() || installRoot,
        protectedPaths
      }
    }
  };
}

function resolvePositiveNumber(raw: unknown): number | undefined {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return n;
}

function applyUsageBudgetDefaults(config: T560Config): T560Config {
  const existingTokenBudget = resolvePositiveNumber(config.usage?.tokenBudget);
  const existingCostBudgetUsd = resolvePositiveNumber(config.usage?.costBudgetUsd);
  const envTokenBudget = resolvePositiveNumber(process.env.T560_USAGE_TOKEN_BUDGET);
  const envCostBudgetUsd = resolvePositiveNumber(process.env.T560_USAGE_COST_BUDGET_USD);
  return {
    ...config,
    usage: {
      tokenBudget: Math.floor(existingTokenBudget ?? envTokenBudget ?? DEFAULT_USAGE_TOKEN_BUDGET),
      costBudgetUsd: existingCostBudgetUsd ?? envCostBudgetUsd ?? DEFAULT_USAGE_COST_BUDGET_USD,
    },
  };
}

function normalizeProviderProfile(id: string, existing?: ProviderProfile): ProviderProfile {
  const catalog = getProviderCatalogEntry(id);
  return {
    enabled: existing?.enabled !== false,
    provider: existing?.provider ?? id,
    authMode: existing?.authMode ?? catalog?.authModes[0] ?? "api_key",
    apiKey: existing?.apiKey,
    oauthToken: existing?.oauthToken,
    token: existing?.token,
    models: existing?.models ?? catalog?.models
  };
}

function extractOAuthTokenFromCredentials(creds: unknown): string | null {
  if (!creds || typeof creds !== "object") {
    return null;
  }
  const obj = creds as Record<string, unknown>;
  const candidates = [
    obj.access,
    obj.accessToken,
    obj.access_token,
    obj.token,
    obj.idToken,
    obj.id_token
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

async function persistOpenAICodexCredentials(creds: unknown): Promise<void> {
  await ensureStateDir();
  const oauthDir = path.join(resolveStateDir(), "oauth");
  await mkdir(oauthDir, { recursive: true });
  const credsPath = path.join(oauthDir, "openai-codex.json");
  await writeFile(credsPath, `${JSON.stringify(creds, null, 2)}\n`, "utf-8");
}

async function configureProviderAuth(params: {
  provider: ProviderCatalogEntry;
  existing?: ProviderProfile;
  note: (message: string, title?: string) => Promise<void>;
  askRequired: (message: string, initial?: string) => Promise<string>;
  choose: <T>(message: string, options: Array<{ label: string; value: T }>) => Promise<T>;
  askYesNo: (message: string, initial?: boolean) => Promise<boolean>;
  progress: (label: string) => { update: (message: string) => void; stop: (message?: string) => void };
}): Promise<ProviderProfile> {
  const base = normalizeProviderProfile(params.provider.id, params.existing);
  const authMode = await params.choose(
    `${params.provider.label} auth mode`,
    params.provider.authModes.map((mode) => ({
      value: mode,
      label:
        mode === "api_key"
          ? "API key"
          : mode === "oauth"
            ? "OAuth token"
            : "Provider token"
    }))
  );

  if (params.provider.authHint) {
    await params.note(params.provider.authHint, params.provider.label);
  }

  let apiKey = base.apiKey;
  let oauthToken = base.oauthToken;
  let token = base.token;
  let baseUrl = base.baseUrl;
  let api = base.api;

  if (authMode === "api_key") {
    apiKey = await params.askRequired(`${params.provider.label} API key:`, apiKey);
    oauthToken = undefined;
    token = undefined;
  } else if (authMode === "oauth") {
    if (params.provider.id === "openai-codex") {
      const useWebAuth = await params.askYesNo(
        "Authenticate OpenAI Codex via web sign-in now?",
        true
      );
      if (useWebAuth) {
        try {
          const creds = await loginOpenAICodexOAuth({
            prompter: {
              note: params.note,
              askRequired: params.askRequired,
              progress: params.progress
            },
            isRemote: isRemoteEnvironment(),
            openUrl: async (url: string) => {
              await openUrl(url);
            },
            localBrowserMessage: "Complete sign-in in browser..."
          });
          if (!creds) {
            throw new Error("OAuth returned no credentials.");
          }
          await persistOpenAICodexCredentials(creds);
          const resolvedToken = extractOAuthTokenFromCredentials(creds);
          if (!resolvedToken) {
            throw new Error("Could not extract OAuth token from returned credentials.");
          }
          oauthToken = resolvedToken;
          await params.note("OpenAI Codex web auth complete.", "OpenAI Codex");
        } catch (error) {
          await params.note(
            `OpenAI Codex web auth failed: ${error instanceof Error ? error.message : String(error)}`,
            "OpenAI Codex"
          );
          const manualFallback = await params.askYesNo(
            "Paste OpenAI Codex OAuth token manually instead?",
            true
          );
          if (!manualFallback) {
            throw error;
          }
          oauthToken = await params.askRequired(`${params.provider.label} OAuth token:`, oauthToken);
        }
      } else {
        oauthToken = await params.askRequired(`${params.provider.label} OAuth token:`, oauthToken);
      }
    } else {
      oauthToken = await params.askRequired(`${params.provider.label} OAuth token:`, oauthToken);
    }
    apiKey = undefined;
    token = undefined;
  } else {
    token = await params.askRequired(`${params.provider.label} setup token:`, token);
    apiKey = undefined;
    oauthToken = undefined;
  }

  const currentModels = base.models ?? params.provider.models;
  const keepModels = await params.askYesNo(
    `Use preset model list for ${params.provider.label} (${currentModels.join(", ")})?`,
    true
  );

  const models = keepModels
    ? currentModels
    : unique(
        parseCsv(
          await params.askRequired(
            `Enter comma-separated model ids for ${params.provider.label}:`,
            currentModels.join(",")
          )
        )
      );

  if (params.provider.id === "openai" || params.provider.id === "local-openai") {
    const suggestedBaseUrl =
      params.provider.id === "local-openai" ? "http://127.0.0.1:8080/v1" : "https://api.openai.com/v1";
    const shouldSetBaseUrl = await params.askYesNo(
      `Set custom API endpoint URL for ${params.provider.label}?`,
      params.provider.id === "local-openai" || Boolean(baseUrl)
    );
    if (shouldSetBaseUrl) {
      baseUrl = await params.askRequired(
        `${params.provider.label} API base URL:`,
        baseUrl ?? suggestedBaseUrl
      );
    } else {
      baseUrl = undefined;
    }

    // Most local OpenAI-compatible servers expose chat completions.
    if (params.provider.id === "local-openai") {
      api = "openai-completions";
    }
  }

  return {
    enabled: true,
    provider: params.provider.id,
    authMode,
    apiKey,
    oauthToken,
    token,
    baseUrl,
    api,
    models
  };
}

function resolveCatalogByProvider(providerId: string): ProviderCatalogEntry {
  return (
    getProviderCatalogEntry(providerId) ?? {
      id: providerId,
      label: providerId,
      description: "Custom provider",
      authModes: ["api_key"],
      models: ["custom-model"],
      defaultModel: "custom-model",
      planningModel: "custom-model",
      codingModel: "custom-model"
    }
  );
}

function hasConfiguredRoute(target: RoutingTarget | undefined): target is RoutingTarget {
  return Boolean(target?.provider?.trim() && target?.model?.trim());
}

function hasCompleteRouting(routing: RoutingConfig | undefined): routing is RoutingConfig {
  if (!routing) {
    return false;
  }
  return (
    hasConfiguredRoute(routing.default) &&
    hasConfiguredRoute(routing.planning) &&
    hasConfiguredRoute(routing.coding)
  );
}

function resolveExistingRouting(config: T560Config): RoutingConfig | undefined {
  if (hasCompleteRouting(config.routing)) {
    return config.routing;
  }

  const defaultRoute = resolveRoutingTarget(config, "default");
  const planningRoute = resolveRoutingTarget(config, "planning");
  const codingRoute = resolveRoutingTarget(config, "coding");
  if (!hasConfiguredRoute(defaultRoute) || !hasConfiguredRoute(planningRoute) || !hasConfiguredRoute(codingRoute)) {
    return undefined;
  }

  return {
    default: defaultRoute,
    planning: planningRoute,
    coding: codingRoute
  };
}

async function chooseRoutingTarget(params: {
  slot: "default" | "planning" | "coding";
  providers: Record<string, ProviderProfile>;
  existing?: RoutingTarget;
  choose: <T>(message: string, options: Array<{ label: string; value: T }>) => Promise<T>;
  askRequired: (message: string, initial?: string) => Promise<string>;
}): Promise<RoutingTarget> {
  const providerIds = Object.keys(params.providers).sort();
  const providerId = await params.choose(
    `Select provider for ${params.slot} route`,
    providerIds.map((id) => {
      const catalog = resolveCatalogByProvider(id);
      return {
        value: id,
        label: `${catalog.label} (${id})`
      };
    })
  );

  const profile = params.providers[providerId];
  const catalog = resolveCatalogByProvider(providerId);
  const providerModels = unique([...(profile.models ?? []), ...catalog.models]);

  const defaultModel =
    params.slot === "planning"
      ? catalog.planningModel
      : params.slot === "coding"
        ? catalog.codingModel
        : catalog.defaultModel;

  const model = await params.choose(`Select model for ${params.slot} route`, [
    ...providerModels.map((modelId) => ({
      value: modelId,
      label: modelId
    })),
    { value: "__custom__", label: "Custom model id" }
  ]);

  if (model === "__custom__") {
    const initial = params.existing?.model ?? defaultModel;
    const customModel = await params.askRequired(`Enter model id for ${providerId}:`, initial);
    return { provider: providerId, model: customModel };
  }

  return { provider: providerId, model };
}

async function writeUsersFile(params: {
  usersPath: string;
  legacyUserPath: string;
  askYesNo: (message: string, initial?: boolean) => Promise<boolean>;
  askRequired: (message: string, initial?: string) => Promise<string>;
}): Promise<void> {
  const shouldWrite = await params.askYesNo("Set up users.md now?", true);
  if (!shouldWrite) {
    return;
  }

  const name = await params.askRequired("Who are you?", "Human operator");
  const about = await params.askRequired(
    "Tell t560 a little about yourself:",
    "I build software and want a reliable AI teammate."
  );
  const goals = await params.askRequired(
    "What are your goals with t560?",
    "Ship features quickly with safe and practical automation."
  );

  const body = [
    "# User Profile",
    "",
    "## Identity",
    `Name: ${name}`,
    "",
    "## About",
    about,
    "",
    "## Goals",
    goals,
    ""
  ].join("\n");

  await writeFile(params.usersPath, body, "utf-8");
  await writeFile(params.legacyUserPath, body, "utf-8");
}

async function writeSoulFile(params: {
  path: string;
  askYesNo: (message: string, initial?: boolean) => Promise<boolean>;
  askRequired: (message: string, initial?: string) => Promise<string>;
}): Promise<void> {
  const shouldWrite = await params.askYesNo("Set up soul.md now?", true);
  if (!shouldWrite) {
    return;
  }

  const useDefault = await params.askYesNo("Use default t560 soul template?", true);
  if (useDefault) {
    const defaultSoul = [
      "# T560 Soul",
      "",
      "## Identity",
      "You are T560, an AI assistant capable of solving real-world tasks from inside a computer.",
      "",
      "## Mission",
      "Help the human complete goals with safe, practical, and high-quality execution.",
      "",
      "## Personality Traits",
      "- Clever",
      "- Patient",
      "- Goal-oriented",
      "- Direct",
      "- Reliable",
      "",
      "## Behavior",
      "Explain clearly, act pragmatically, avoid unnecessary complexity, and keep momentum.",
      ""
    ].join("\n");
    await writeFile(params.path, defaultSoul, "utf-8");
    return;
  }

  const identity = await params.askRequired(
    "Soul identity statement:",
    "You are T560, an AI assistant living in a computer."
  );
  const mission = await params.askRequired(
    "Soul mission:",
    "Help the human achieve goals with practical, safe execution."
  );
  const traits = unique(
    parseCsv(
      await params.askRequired(
        "Personality traits (comma separated):",
        "clever, patient, goal-oriented"
      )
    )
  );
  const behavior = await params.askRequired(
    "Behavior guidelines:",
    "Be clear, calm, practical, and focused on outcomes."
  );

  const body = [
    "# T560 Soul",
    "",
    "## Identity",
    identity,
    "",
    "## Mission",
    mission,
    "",
    "## Personality Traits",
    ...traits.map((trait) => `- ${trait}`),
    "",
    "## Behavior",
    behavior,
    ""
  ].join("\n");
  await writeFile(params.path, body, "utf-8");
}

async function configureTelegram(params: {
  config: T560Config;
  note: (message: string, title?: string) => Promise<void>;
  askYesNo: (message: string, initial?: boolean) => Promise<boolean>;
  askRequired: (message: string, initial?: string) => Promise<string>;
  choose: <T>(message: string, options: Array<{ label: string; value: T }>) => Promise<T>;
}): Promise<T560Config> {
  const current = params.config.channels?.telegram;
  const enable = await params.askYesNo("Configure Telegram now? (optional, you can do it later)", Boolean(current));
  if (!enable) {
    return params.config;
  }

  await params.note(
    [
      "1. Open Telegram and message @BotFather",
      "2. Run /newbot (or /mybots) and create your bot",
      "3. Copy token (looks like 123456:ABC...)",
      "4. Send /start to your bot once from your own Telegram account"
    ].join("\n"),
    "Telegram setup"
  );

  const token = await params.askRequired("Telegram bot token:", current?.botToken);

  const dmPolicy = await params.choose<TelegramDmPolicy>("Telegram DM policy", [
    { value: "pairing", label: "Pairing (recommended, approve with t560 pairing approve telegram <code>)" },
    { value: "allowlist", label: "Allowlist (only specific chat IDs)" },
    { value: "open", label: "Open (any Telegram user can talk)" },
    { value: "disabled", label: "Disabled (ignore Telegram DMs)" }
  ]);

  let allowFrom: string[] | undefined;
  let allowedChatIds: number[] | undefined;

  if (dmPolicy === "allowlist") {
    const raw = await params.askRequired(
      "Enter Telegram numeric chat IDs (comma separated):",
      (current?.allowedChatIds ?? []).join(",")
    );
    allowedChatIds = unique(parseCsv(raw))
      .map((entry) => Number(entry))
      .filter((entry) => Number.isInteger(entry));
    allowFrom = allowedChatIds.map((entry) => String(entry));
  }

  if (dmPolicy === "open") {
    allowFrom = ["*"];
  }

  return {
    ...params.config,
    channels: {
      ...params.config.channels,
      telegram: {
        botToken: token,
        dmPolicy,
        allowFrom,
        allowedChatIds
      }
    }
  };
}

function toLegacyModel(target: RoutingTarget | undefined): string | undefined {
  if (!target?.provider || !target?.model) {
    return undefined;
  }
  return `${target.provider}/${target.model}`;
}

export async function runOnboarding(): Promise<void> {
  await ensureStateDir();

  const status = await readOnboardingStatus();
  const initialConfig = await readConfig();
  const installRoot = resolveInstallRootForOnboarding();
  const prompter = createClackOnboardingPrompter();

  try {
    await prompter.intro("T560 onboarding");
    await prompter.note(`Config path: ${status.configPath}`, "Config");
    let updateScope: "provider_only" | "full" = "full";
    if (status.onboarded) {
      await prompter.note("Current status: onboarded", "Status");
      const proceed = await prompter.askYesNo("Re-run onboarding and update config?", true);
      if (!proceed) {
        await prompter.outro("No changes made.");
        return;
      }
      updateScope = await prompter.choose("What do you want to update?", [
        {
          value: "provider_only",
          label: "Provider + model routing only (OAuth/API keys)"
        },
        {
          value: "full",
          label: "Full onboarding (providers, routing, channels, profile files)"
        }
      ]);
    } else {
      await prompter.note(`Missing: ${status.missing.join(", ") || "none"}`, "Status");
    }
    const providerOnly = updateScope === "provider_only";
    if (providerOnly) {
      await prompter.note(
        "Provider-only mode: this will skip Telegram and profile files so you can quickly switch provider/model auth.",
        "Mode"
      );
    }

    const catalog = listProviderCatalog();
    let providers: Record<string, ProviderProfile> = {
      ...(initialConfig.providers ?? {})
    };

    const keepExistingProviders =
      Object.keys(providers).length > 0
        ? await prompter.askYesNo(
            providerOnly
              ? "Keep existing providers without re-auth? (choose No to sign in/change provider)"
              : "Keep existing configured providers?",
            providerOnly ? false : true
          )
        : false;
    if (!keepExistingProviders) {
      providers = {};
    }

    const existingRouting = resolveExistingRouting(initialConfig);
    const keepExistingRouting =
      keepExistingProviders && hasCompleteRouting(existingRouting)
        ? await prompter.askYesNo(
            providerOnly
              ? "Keep existing model routing as-is?"
              : "Keep existing configured model routing?",
            providerOnly ? false : true
          )
        : false;

    if (!keepExistingRouting) {
      for (;;) {
        const providerOptions = catalog.map((entry) => ({
          value: entry.id,
          label: `${entry.label} (${entry.id}) - ${entry.description}`
        }));

        const picked = await prompter.choose("Select provider to configure", [
          ...providerOptions,
          { value: "__done__", label: "Done adding providers" }
        ]);

        if (picked === "__done__") {
          if (Object.keys(providers).length === 0) {
            process.stdout.write("You must configure at least one provider.\n");
            continue;
          }
          break;
        }

        const provider = getProviderCatalogEntry(picked);
        if (!provider) {
          process.stdout.write(`Unknown provider: ${picked}\n`);
          continue;
        }

        const profile = await configureProviderAuth({
          provider,
          existing: providers[picked],
          note: prompter.note,
          askRequired: prompter.askRequired,
          choose: prompter.choose,
          askYesNo: prompter.askYesNo,
          progress: prompter.progress
        });
        providers[picked] = profile;

        const addMore = await prompter.askYesNo("Configure another provider?", true);
        if (!addMore) {
          break;
        }
      }
    } else {
      await prompter.note("Keeping existing providers and model routing.", "Providers");
    }

    const routing: RoutingConfig =
      keepExistingRouting && existingRouting
        ? existingRouting
        : {
            default: await chooseRoutingTarget({
              slot: "default",
              providers,
              existing: existingRouting?.default,
              choose: prompter.choose,
              askRequired: prompter.askRequired
            }),
            planning: await chooseRoutingTarget({
              slot: "planning",
              providers,
              existing: existingRouting?.planning,
              choose: prompter.choose,
              askRequired: prompter.askRequired
            }),
            coding: await chooseRoutingTarget({
              slot: "coding",
              providers,
              existing: existingRouting?.coding,
              choose: prompter.choose,
              askRequired: prompter.askRequired
            })
          };

    let nextConfig: T560Config = {
      ...initialConfig,
      providers,
      routing,
      provider: routing.default?.provider,
      models: {
        default: toLegacyModel(routing.default),
        planning: toLegacyModel(routing.planning),
        coding: toLegacyModel(routing.coding)
      }
    };

    if (!providerOnly) {
      nextConfig = await configureTelegram({
        config: nextConfig,
        note: prompter.note,
        askYesNo: prompter.askYesNo,
        askRequired: prompter.askRequired,
        choose: prompter.choose
      });

      await writeUsersFile({
        usersPath: resolveUsersPath(),
        legacyUserPath: resolveUserPath(),
        askYesNo: prompter.askYesNo,
        askRequired: prompter.askRequired
      });

      await writeSoulFile({
        path: resolveSoulPath(),
        askYesNo: prompter.askYesNo,
        askRequired: prompter.askRequired
      });
    }

    nextConfig = applySelfProtectionDefaults(nextConfig, installRoot);
    nextConfig = applyUsageBudgetDefaults(nextConfig);

    await writeConfig(nextConfig);
    const nextStatus = await readOnboardingStatus();

    await prompter.note(`Config: ${nextStatus.configPath}`, "Saved");
    await prompter.note(`Status: ${nextStatus.onboarded ? "onboarded" : "incomplete"}`, "Saved");
    if (nextStatus.missing.length > 0) {
      await prompter.note(`Still missing: ${nextStatus.missing.join(", ")}`, "Saved");
    }
    await prompter.note(
      "Telegram pairing approval command: t560 pairing approve telegram <code>",
      "Telegram"
    );
    await prompter.outro("Onboarding saved.");
  } catch (error) {
    if (error instanceof OnboardingCancelledError) {
      return;
    }
    throw error;
  } finally {
    prompter.close();
  }
}
