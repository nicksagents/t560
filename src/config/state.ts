import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ModelPresets = {
  default?: string;
  planning?: string;
  coding?: string;
};

export type ProviderAuthMode = "api_key" | "oauth" | "token";

export type ProviderProfile = {
  enabled?: boolean;
  provider: string;
  authMode: ProviderAuthMode;
  apiKey?: string;
  oauthToken?: string;
  token?: string;
  baseUrl?: string;
  api?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: string[];
};

export type RoutingTarget = {
  provider?: string;
  model?: string;
};

export type RoutingConfig = {
  default?: RoutingTarget;
  planning?: RoutingTarget;
  coding?: RoutingTarget;
};

export type TelegramDmPolicy = "pairing" | "allowlist" | "open" | "disabled";

export type TelegramChannelConfig = {
  botToken?: string;
  dmPolicy?: TelegramDmPolicy;
  allowFrom?: string[];
  allowedChatIds?: number[];
};

export type ChannelConfig = {
  telegram?: TelegramChannelConfig;
};

export type ToolPolicyConfig = {
  allow?: string[];
  deny?: string[];
};

export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";

export type WebSearchProvider = "brave" | "duckduckgo";

export type WebSearchToolConfig = {
  enabled?: boolean;
  provider?: WebSearchProvider;
  apiKey?: string;
  timeoutMs?: number;
  maxResults?: number;
  region?: string;
  fetchTop?: number;
  fetchMaxBytes?: number;
};

export type WebFetchToolConfig = {
  enabled?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
};

export type WebToolsConfig = {
  search?: WebSearchToolConfig;
  fetch?: WebFetchToolConfig;
};

export type ToolsConfig = {
  dangerouslyUnrestricted?: boolean;
  profile?: ToolProfileId;
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
  byProvider?: Record<string, ToolPolicyConfig>;
  runtime?: ToolPolicyConfig;
  fs?: {
    workspaceOnly?: boolean;
  };
  exec?: {
    timeoutSec?: number;
    allowBackground?: boolean;
  };
  web?: WebToolsConfig;
  selfProtection?: {
    enabled?: boolean;
    installRoot?: string;
    protectedPaths?: string[];
  };
};

export type SkillsEntryConfig = {
  enabled?: boolean;
};

export type SkillsConfig = {
  allow?: string[];
  dirs?: string[];
  entries?: Record<string, SkillsEntryConfig>;
};

export type UsageConfig = {
  tokenBudget?: number;
  costBudgetUsd?: number;
};

export type AgentDefaultsConfig = {
  bootstrapMaxChars?: number;
};

export type AgentsConfig = {
  defaults?: AgentDefaultsConfig;
};

export type T560Config = {
  provider?: string;
  models?: ModelPresets;
  providers?: Record<string, ProviderProfile>;
  routing?: RoutingConfig;
  channels?: ChannelConfig;
  tools?: ToolsConfig;
  skills?: SkillsConfig;
  usage?: UsageConfig;
  agents?: AgentsConfig;
};

export type OnboardingStatus = {
  onboarded: boolean;
  missing: string[];
  config: T560Config;
  configPath: string;
};

const DEFAULT_SOUL = [
  "# Soul",
  "",
  "You are t560, a practical coding agent.",
  "Be direct, concise, and truthful about tool outcomes.",
].join("\n");

const DEFAULT_USERS = [
  "# Users",
  "",
  "Name: Human operator",
  "Preferences: concise, practical engineering help",
].join("\n");

function hasRealValue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized !== "set-me" && normalized !== "change-me" && normalized !== "todo";
}

function hasRealModelRef(value: string | undefined): boolean {
  if (!hasRealValue(value)) {
    return false;
  }
  const trimmed = String(value).trim();
  return trimmed.includes("/") && trimmed.split("/").every((part) => hasRealValue(part));
}

export function parseModelRef(value: string | undefined): RoutingTarget | undefined {
  if (!hasRealModelRef(value)) {
    return undefined;
  }
  const [provider, ...rest] = String(value).split("/");
  const model = rest.join("/").trim();
  if (!hasRealValue(provider) || !hasRealValue(model)) {
    return undefined;
  }
  return { provider: provider.trim(), model };
}

function parseTelegramDmPolicy(value: unknown): TelegramDmPolicy {
  const normalized = String(value ?? "pairing").trim().toLowerCase();
  if (normalized === "allowlist") {
    return "allowlist";
  }
  if (normalized === "open") {
    return "open";
  }
  if (normalized === "disabled") {
    return "disabled";
  }
  return "pairing";
}

export function resolveStateDir(): string {
  return path.join(os.homedir(), ".t560");
}

export function resolveConfigPath(): string {
  return path.join(resolveStateDir(), "config.json");
}

export function resolvePairingPath(): string {
  return path.join(resolveStateDir(), "pairing.json");
}

export function resolveSoulPath(): string {
  return path.join(resolveStateDir(), "soul.md");
}

export function resolveUsersPath(): string {
  return path.join(resolveStateDir(), "users.md");
}

export function resolveLegacyUserPath(): string {
  return path.join(resolveStateDir(), "user.md");
}

export function resolveUserPath(): string {
  return resolveLegacyUserPath();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeStringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const values = raw.map((value) => String(value).trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function normalizeToolPolicy(raw: unknown): ToolPolicyConfig | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const allow = normalizeStringList(obj.allow);
  const deny = normalizeStringList(obj.deny);
  if (!allow && !deny) {
    return undefined;
  }
  return { allow, deny };
}

function normalizeProviders(raw: unknown): Record<string, ProviderProfile> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const result: Record<string, ProviderProfile> = {};
  for (const [providerId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const obj = value as Record<string, unknown>;
    const providerName =
      typeof obj.provider === "string" && obj.provider.trim() ? obj.provider.trim() : providerId;

    const authModeRaw = String(obj.authMode ?? "api_key").trim();
    const authMode: ProviderAuthMode =
      authModeRaw === "oauth" || authModeRaw === "token" ? authModeRaw : "api_key";

    const models = Array.isArray(obj.models)
      ? obj.models.map((entry) => String(entry).trim()).filter(Boolean)
      : undefined;
    const baseUrl =
      typeof obj.baseUrl === "string" && obj.baseUrl.trim() ? obj.baseUrl.trim() : undefined;
    const api = typeof obj.api === "string" && obj.api.trim() ? obj.api.trim() : undefined;
    const headers =
      obj.headers && typeof obj.headers === "object"
        ? Object.fromEntries(
            Object.entries(obj.headers as Record<string, unknown>)
              .map(([key, value]) => [String(key), String(value)])
              .filter(([key, value]) => key.trim().length > 0 && value.trim().length > 0),
          )
        : undefined;
    const compat =
      obj.compat && typeof obj.compat === "object"
        ? (obj.compat as Record<string, unknown>)
        : undefined;

    result[providerId] = {
      enabled: obj.enabled !== false,
      provider: providerName,
      authMode,
      apiKey: typeof obj.apiKey === "string" ? obj.apiKey : undefined,
      oauthToken: typeof obj.oauthToken === "string" ? obj.oauthToken : undefined,
      token: typeof obj.token === "string" ? obj.token : undefined,
      baseUrl,
      api,
      headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
      compat,
      models,
    };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeRouting(raw: unknown): RoutingConfig | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const parseSlot = (value: unknown): RoutingTarget | undefined => {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const slot = value as Record<string, unknown>;
    const provider = typeof slot.provider === "string" ? slot.provider.trim() : "";
    const model = typeof slot.model === "string" ? slot.model.trim() : "";
    if (!hasRealValue(provider) || !hasRealValue(model)) {
      return undefined;
    }
    return { provider, model };
  };

  const next: RoutingConfig = {
    default: parseSlot((raw as Record<string, unknown>).default),
    planning: parseSlot((raw as Record<string, unknown>).planning),
    coding: parseSlot((raw as Record<string, unknown>).coding),
  };

  return next.default || next.planning || next.coding ? next : undefined;
}

function normalizeTools(raw: unknown): ToolsConfig | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const obj = raw as Record<string, unknown>;
  const byProvider: Record<string, ToolPolicyConfig> = {};
  const byProviderRaw = obj.byProvider;

  if (byProviderRaw && typeof byProviderRaw === "object") {
    for (const [provider, value] of Object.entries(byProviderRaw as Record<string, unknown>)) {
      const normalized = normalizeToolPolicy(value);
      if (normalized) {
        byProvider[provider] = normalized;
      }
    }
  }

  const profileRaw = String(obj.profile ?? "").trim().toLowerCase();
  const profile =
    profileRaw === "minimal" ||
    profileRaw === "coding" ||
    profileRaw === "messaging" ||
    profileRaw === "full"
      ? (profileRaw as ToolProfileId)
      : undefined;

  const webRaw = obj.web;
  const webObj = webRaw && typeof webRaw === "object" ? (webRaw as Record<string, unknown>) : null;
  const searchRaw =
    webObj?.search && typeof webObj.search === "object"
      ? (webObj.search as Record<string, unknown>)
      : null;
  const fetchRaw =
    webObj?.fetch && typeof webObj.fetch === "object"
      ? (webObj.fetch as Record<string, unknown>)
      : null;
  const providerRaw = String(searchRaw?.provider ?? "").trim().toLowerCase();
  const searchProvider =
    providerRaw === "duckduckgo" || providerRaw === "brave"
      ? (providerRaw as WebSearchProvider)
      : undefined;

  const web: WebToolsConfig | undefined = webObj
    ? {
        search: searchRaw
          ? {
              enabled: typeof searchRaw.enabled === "boolean" ? searchRaw.enabled : undefined,
              provider: searchProvider,
              apiKey: typeof searchRaw.apiKey === "string" ? (searchRaw.apiKey.trim() || undefined) : undefined,
              timeoutMs:
                typeof searchRaw.timeoutMs === "number" && Number.isFinite(searchRaw.timeoutMs)
                  ? Math.max(1000, Math.floor(searchRaw.timeoutMs))
                  : undefined,
              maxResults:
                typeof searchRaw.maxResults === "number" && Number.isFinite(searchRaw.maxResults)
                  ? Math.max(1, Math.floor(searchRaw.maxResults))
                  : undefined,
              region:
                typeof searchRaw.region === "string" ? (searchRaw.region.trim() || undefined) : undefined,
              fetchTop:
                typeof searchRaw.fetchTop === "number" && Number.isFinite(searchRaw.fetchTop)
                  ? Math.max(0, Math.floor(searchRaw.fetchTop))
                  : undefined,
              fetchMaxBytes:
                typeof searchRaw.fetchMaxBytes === "number" && Number.isFinite(searchRaw.fetchMaxBytes)
                  ? Math.max(10_000, Math.floor(searchRaw.fetchMaxBytes))
                  : undefined,
            }
          : undefined,
        fetch: fetchRaw
          ? {
              enabled: typeof fetchRaw.enabled === "boolean" ? fetchRaw.enabled : undefined,
              timeoutMs:
                typeof fetchRaw.timeoutMs === "number" && Number.isFinite(fetchRaw.timeoutMs)
                  ? Math.max(1000, Math.floor(fetchRaw.timeoutMs))
                  : undefined,
              maxBytes:
                typeof fetchRaw.maxBytes === "number" && Number.isFinite(fetchRaw.maxBytes)
                  ? Math.max(10_000, Math.floor(fetchRaw.maxBytes))
                  : undefined,
            }
          : undefined,
      }
    : undefined;

  return {
    dangerouslyUnrestricted:
      typeof obj.dangerouslyUnrestricted === "boolean"
        ? (obj.dangerouslyUnrestricted as boolean)
        : undefined,
    profile,
    allow: normalizeStringList(obj.allow),
    alsoAllow: normalizeStringList(obj.alsoAllow),
    deny: normalizeStringList(obj.deny),
    byProvider: Object.keys(byProvider).length > 0 ? byProvider : undefined,
    runtime: normalizeToolPolicy(obj.runtime),
    fs:
      obj.fs && typeof obj.fs === "object"
        ? {
            workspaceOnly:
              typeof (obj.fs as Record<string, unknown>).workspaceOnly === "boolean"
                ? ((obj.fs as Record<string, unknown>).workspaceOnly as boolean)
                : undefined,
          }
        : undefined,
    exec:
      obj.exec && typeof obj.exec === "object"
        ? {
            timeoutSec:
              typeof (obj.exec as Record<string, unknown>).timeoutSec === "number"
                ? Number((obj.exec as Record<string, unknown>).timeoutSec)
                : undefined,
            allowBackground:
              typeof (obj.exec as Record<string, unknown>).allowBackground === "boolean"
                ? ((obj.exec as Record<string, unknown>).allowBackground as boolean)
                : undefined,
          }
        : undefined,
    web,
    selfProtection:
      obj.selfProtection && typeof obj.selfProtection === "object"
        ? {
            enabled:
              typeof (obj.selfProtection as Record<string, unknown>).enabled === "boolean"
                ? ((obj.selfProtection as Record<string, unknown>).enabled as boolean)
                : undefined,
            installRoot:
              typeof (obj.selfProtection as Record<string, unknown>).installRoot === "string"
                ? (String((obj.selfProtection as Record<string, unknown>).installRoot).trim() || undefined)
                : undefined,
            protectedPaths: normalizeStringList(
              (obj.selfProtection as Record<string, unknown>).protectedPaths
            ),
          }
        : undefined,
  };
}

function normalizeSkills(raw: unknown): SkillsConfig | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const obj = raw as Record<string, unknown>;
  const entriesRaw = obj.entries;
  const entries: Record<string, SkillsEntryConfig> = {};

  if (entriesRaw && typeof entriesRaw === "object") {
    for (const [key, value] of Object.entries(entriesRaw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const enabled = (value as Record<string, unknown>).enabled;
      entries[key] = {
        enabled: typeof enabled === "boolean" ? enabled : undefined,
      };
    }
  }

  return {
    allow: normalizeStringList(obj.allow),
    dirs: normalizeStringList(obj.dirs),
    entries: Object.keys(entries).length > 0 ? entries : undefined,
  };
}

function normalizeUsage(raw: unknown): UsageConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const tokenBudgetNum = Number(obj.tokenBudget);
  const costBudgetUsdNum = Number(obj.costBudgetUsd);
  const tokenBudget =
    Number.isFinite(tokenBudgetNum) && tokenBudgetNum > 0
      ? Math.floor(tokenBudgetNum)
      : undefined;
  const costBudgetUsd =
    Number.isFinite(costBudgetUsdNum) && costBudgetUsdNum > 0
      ? costBudgetUsdNum
      : undefined;
  if (!tokenBudget && !costBudgetUsd) {
    return undefined;
  }
  return {
    tokenBudget,
    costBudgetUsd,
  };
}

function normalizeAgents(raw: unknown): AgentsConfig | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const defaultsRaw = obj.defaults;
  if (!defaultsRaw || typeof defaultsRaw !== "object") {
    return undefined;
  }
  const defaultsObj = defaultsRaw as Record<string, unknown>;
  const bootstrapMaxCharsRaw = defaultsObj.bootstrapMaxChars;
  const bootstrapMaxCharsNum = Number(bootstrapMaxCharsRaw);
  const bootstrapMaxChars =
    Number.isFinite(bootstrapMaxCharsNum) && bootstrapMaxCharsNum > 0
      ? Math.floor(bootstrapMaxCharsNum)
      : undefined;
  if (!bootstrapMaxChars) {
    return undefined;
  }
  return {
    defaults: {
      bootstrapMaxChars,
    },
  };
}

function normalizeChannels(raw: unknown): ChannelConfig | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const telegramRaw = (raw as Record<string, unknown>).telegram;
  if (!telegramRaw || typeof telegramRaw !== "object") {
    return undefined;
  }

  const obj = telegramRaw as Record<string, unknown>;
  const allowFrom = Array.isArray(obj.allowFrom)
    ? (obj.allowFrom as unknown[])
        .map((entry) => String(entry).replace(/^(telegram|tg):/i, "").trim())
        .filter(Boolean)
    : undefined;

  const allowedChatIds = Array.isArray(obj.allowedChatIds)
    ? (obj.allowedChatIds as unknown[])
        .map((entry) => Number(entry))
        .filter((entry) => Number.isInteger(entry))
    : undefined;

  return {
    telegram: {
      botToken: typeof obj.botToken === "string" ? String(obj.botToken) : undefined,
      dmPolicy: parseTelegramDmPolicy(obj.dmPolicy),
      allowFrom: allowFrom && allowFrom.length > 0 ? allowFrom : undefined,
      allowedChatIds: allowedChatIds && allowedChatIds.length > 0 ? allowedChatIds : undefined,
    },
  };
}

function normalizeConfig(value: unknown): T560Config {
  if (!value || typeof value !== "object") {
    return {};
  }

  const obj = value as Record<string, unknown>;
  const modelsRaw = obj.models;
  const models: ModelPresets | undefined =
    modelsRaw && typeof modelsRaw === "object"
      ? {
          default:
            typeof (modelsRaw as Record<string, unknown>).default === "string"
              ? String((modelsRaw as Record<string, unknown>).default)
              : undefined,
          planning:
            typeof (modelsRaw as Record<string, unknown>).planning === "string"
              ? String((modelsRaw as Record<string, unknown>).planning)
              : undefined,
          coding:
            typeof (modelsRaw as Record<string, unknown>).coding === "string"
              ? String((modelsRaw as Record<string, unknown>).coding)
              : undefined,
        }
      : undefined;

  return {
    provider: typeof obj.provider === "string" ? obj.provider : undefined,
    models,
    providers: normalizeProviders(obj.providers),
    routing: normalizeRouting(obj.routing),
    channels: normalizeChannels(obj.channels),
    tools: normalizeTools(obj.tools),
    skills: normalizeSkills(obj.skills),
    usage: normalizeUsage(obj.usage),
    agents: normalizeAgents(obj.agents),
  };
}

export async function ensureStateDir(): Promise<void> {
  const dir = resolveStateDir();
  await mkdir(dir, { recursive: true });

  const soulPath = resolveSoulPath();
  const usersPath = resolveUsersPath();
  if (!(await fileExists(soulPath))) {
    await writeFile(soulPath, `${DEFAULT_SOUL}\n`, "utf-8");
  }
  if (!(await fileExists(usersPath))) {
    await writeFile(usersPath, `${DEFAULT_USERS}\n`, "utf-8");
  }
}

export async function readConfig(): Promise<T560Config> {
  await ensureStateDir();
  const raw = await readJsonIfExists(resolveConfigPath());
  return normalizeConfig(raw);
}

export async function writeConfig(config: T560Config): Promise<void> {
  await ensureStateDir();
  const normalized = normalizeConfig(config);
  await writeFile(resolveConfigPath(), `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
}

function hasProviderCredential(profile: ProviderProfile | undefined): boolean {
  if (!profile) {
    return false;
  }
  return (
    hasRealValue(profile.apiKey) ||
    hasRealValue(profile.oauthToken) ||
    hasRealValue(profile.token)
  );
}

function providerCanRunWithoutCredential(
  providerId: string,
  profile: ProviderProfile | undefined
): boolean {
  if (!profile) {
    return false;
  }
  const baseUrl = profile.baseUrl?.trim();
  if (!hasRealValue(baseUrl)) {
    return false;
  }
  const providerName = (profile.provider ?? "").trim().toLowerCase();
  const routeProviderId = providerId.trim().toLowerCase();
  return providerName === "openai" || routeProviderId === "local-openai";
}

function resolveSelfProtectionInstallRoot(raw: string | undefined): string | undefined {
  if (!hasRealValue(raw)) {
    return undefined;
  }
  const trimmed = String(raw).trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.resolve(path.join(os.homedir(), trimmed.slice(2)));
  }
  return path.resolve(trimmed);
}

function resolveRouteFromModelPreset(
  config: T560Config,
  slot: keyof ModelPresets,
): RoutingTarget | undefined {
  const modelPreset = config.models?.[slot];
  if (!hasRealValue(modelPreset)) {
    return undefined;
  }

  const direct = parseModelRef(modelPreset);
  if (direct?.provider && direct.model) {
    return direct;
  }

  const providerId = config.provider?.trim();
  if (!hasRealValue(providerId)) {
    return undefined;
  }

  return { provider: providerId, model: String(modelPreset).trim() };
}

export function resolveBootstrapMaxChars(config: T560Config): number | undefined {
  const envRaw = process.env.T560_BOOTSTRAP_MAX_CHARS?.trim();
  const envValue = envRaw ? Number(envRaw) : undefined;
  if (Number.isFinite(envValue) && Number(envValue) > 0) {
    return Math.floor(Number(envValue));
  }
  const configValue = Number(config.agents?.defaults?.bootstrapMaxChars);
  if (Number.isFinite(configValue) && configValue > 0) {
    return Math.floor(configValue);
  }
  return undefined;
}

export function resolveRoutingTarget(
  config: T560Config,
  slot: "default" | "planning" | "coding",
): RoutingTarget | undefined {
  const fromRouting = config.routing?.[slot];
  if (fromRouting?.provider && fromRouting.model) {
    return { provider: fromRouting.provider, model: fromRouting.model };
  }

  const fromPreset = resolveRouteFromModelPreset(config, slot);
  if (fromPreset) {
    return fromPreset;
  }

  if (slot !== "default") {
    const fallback = config.routing?.default;
    if (fallback?.provider && fallback.model) {
      return { provider: fallback.provider, model: fallback.model };
    }
    const defaultPreset = resolveRouteFromModelPreset(config, "default");
    if (defaultPreset) {
      return defaultPreset;
    }
  }

  return undefined;
}

export function resolveTelegramBotToken(config: T560Config): string | undefined {
  const envToken = process.env.T560_TELEGRAM_BOT_TOKEN?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (hasRealValue(envToken)) {
    return envToken;
  }
  const configToken = config.channels?.telegram?.botToken?.trim();
  if (hasRealValue(configToken)) {
    return configToken;
  }
  return undefined;
}

export function isAllowedTelegramSender(config: T560Config, sender: string | number): boolean {
  const normalized = String(sender).replace(/^(telegram|tg):/i, "").trim();
  if (!normalized) {
    return false;
  }

  const allowFrom = config.channels?.telegram?.allowFrom ?? [];
  if (allowFrom.some((entry) => String(entry).replace(/^(telegram|tg):/i, "").trim() === normalized)) {
    return true;
  }

  const asNumber = Number(normalized);
  if (Number.isInteger(asNumber)) {
    const allowedChatIds = config.channels?.telegram?.allowedChatIds ?? [];
    if (allowedChatIds.includes(asNumber)) {
      return true;
    }
  }

  return false;
}

export async function readOnboardingStatus(): Promise<OnboardingStatus> {
  await ensureStateDir();
  const configPath = resolveConfigPath();
  const config = await readConfig();

  const missing: string[] = [];

  const providers = config.providers ?? {};
  const hasProviders = Object.keys(providers).length > 0;
  if (!hasProviders) {
    missing.push("providers");
  } else {
    const hasAnyCredential = Object.values(providers).some((profile) => hasProviderCredential(profile));
    if (!hasAnyCredential) {
      missing.push("providers.credentials");
    }
  }

  const defaultRoute = resolveRoutingTarget(config, "default");
  const planningRoute = resolveRoutingTarget(config, "planning");
  const codingRoute = resolveRoutingTarget(config, "coding");

  if (!defaultRoute?.provider || !defaultRoute.model) {
    missing.push("routing.default");
  }
  if (!planningRoute?.provider || !planningRoute.model) {
    missing.push("routing.planning");
  }
  if (!codingRoute?.provider || !codingRoute.model) {
    missing.push("routing.coding");
  }

  const routedProviders = new Set<string>(
    [defaultRoute?.provider, planningRoute?.provider, codingRoute?.provider]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
  );
  for (const providerId of routedProviders) {
    const profile = providers[providerId];
    if (!profile) {
      missing.push(`providers.${providerId}`);
      continue;
    }
    if (!hasProviderCredential(profile) && !providerCanRunWithoutCredential(providerId, profile)) {
      missing.push(`providers.${providerId}.credentials`);
    }
  }

  const selfProtection = config.tools?.selfProtection;
  if (!selfProtection || selfProtection.enabled !== true) {
    missing.push("tools.selfProtection.enabled");
  }
  const installRoot = resolveSelfProtectionInstallRoot(selfProtection?.installRoot);
  if (!installRoot) {
    missing.push("tools.selfProtection.installRoot");
  } else if (!(await fileExists(installRoot))) {
    missing.push("tools.selfProtection.installRoot.exists");
  }
  const protectedPaths = (selfProtection?.protectedPaths ?? [])
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  if (protectedPaths.length === 0) {
    missing.push("tools.selfProtection.protectedPaths");
  }

  const soulPath = resolveSoulPath();
  const usersPath = resolveUsersPath();
  const legacyUserPath = resolveLegacyUserPath();
  const soulExists = await fileExists(soulPath);
  const usersExists = await fileExists(usersPath);
  const legacyUserExists = await fileExists(legacyUserPath);

  if (!soulExists) {
    missing.push("soul.md");
  }
  if (!usersExists) {
    missing.push("users.md");
  }
  if (!legacyUserExists) {
    missing.push("user.md");
  }

  return {
    onboarded: missing.length === 0,
    missing,
    config,
    configPath,
  };
}
