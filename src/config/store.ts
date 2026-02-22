import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig, ProviderCredential } from "./types.js";

const CONFIG_DIR = path.join(os.homedir(), ".config", "t560");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function defaultConfig(): AppConfig {
  return {
    version: 1,
    onboardingCompleted: false,
    providers: [],
    models: null,
    telegram: {
      enabled: false,
      botToken: "",
      accessMode: "disabled",
      allowedChatIds: [],
    },
  };
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    const rawProviders = Array.isArray(parsed.providers) ? parsed.providers : [];
    const providers: ProviderCredential[] = [];
    rawProviders.forEach((entry, index) => {
        const candidate = entry as Partial<ProviderCredential> & Record<string, unknown>;
        const provider = candidate.provider;
        const kind = candidate.kind;
        const token = typeof candidate.token === "string" ? candidate.token : "";
        const addedAt =
          typeof candidate.addedAt === "string" && candidate.addedAt.trim()
            ? candidate.addedAt
            : new Date().toISOString();
        if (
          provider !== "openai-codex" &&
          provider !== "anthropic" &&
          provider !== "deepseek"
        ) {
          return;
        }
        if (kind !== "oauth-token" && kind !== "setup-token" && kind !== "api-key") {
          return;
        }
        const fallbackProfile =
          provider === "anthropic" && kind === "setup-token"
            ? "anthropic:default"
            : `${provider}:${kind}:${index}`;
        providers.push({
          profileId:
            typeof candidate.profileId === "string" && candidate.profileId.trim()
              ? candidate.profileId.trim()
              : fallbackProfile,
          provider,
          kind,
          token,
          addedAt,
          expiresAt: typeof candidate.expiresAt === "number" ? candidate.expiresAt : undefined,
          oauth:
            candidate.oauth && typeof candidate.oauth === "object"
              ? (candidate.oauth as ProviderCredential["oauth"])
              : undefined,
          metadata:
            candidate.metadata && typeof candidate.metadata === "object"
              ? (candidate.metadata as Record<string, unknown>)
              : undefined,
        });
      });

    return {
      ...defaultConfig(),
      ...parsed,
      providers,
      telegram: {
        ...defaultConfig().telegram,
        ...(parsed.telegram ?? {}),
        allowedChatIds: Array.isArray(parsed.telegram?.allowedChatIds)
          ? parsed.telegram.allowedChatIds.map((v) => String(v))
          : [],
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultConfig();
    }
    throw error;
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function upsertProviderCredential(
  providers: ProviderCredential[],
  next: ProviderCredential,
): ProviderCredential[] {
  const filtered = providers.filter((entry) => entry.profileId !== next.profileId);
  return [...filtered, next];
}

export function resolveProviderCredential(config: AppConfig, provider: ProviderCredential["provider"]) {
  const matches = config.providers.filter((entry) => entry.provider === provider);
  if (matches.length === 0) {
    return null;
  }
  return matches[matches.length - 1];
}
