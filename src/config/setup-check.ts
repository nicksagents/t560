import type { AppConfig, ProviderCredential, ProviderId } from "./types.js";

export type SetupCheck = {
  ok: boolean;
  reasons: string[];
};

type ModelRole = "defaultModel" | "planningModel" | "codingModel";

type CredentialValidation = {
  ok: boolean;
  reason?: string;
};

function mapModelProviderToProviderId(modelProvider: string): ProviderId | null {
  if (modelProvider === "openai" || modelProvider === "openai-codex") {
    return "openai-codex";
  }
  if (modelProvider === "anthropic") {
    return "anthropic";
  }
  if (modelProvider === "deepseek") {
    return "deepseek";
  }
  return null;
}

function validateCredential(entry: ProviderCredential): CredentialValidation {
  const token = entry.token.trim();
  if (!token) {
    return { ok: false, reason: `${entry.profileId}: token is empty` };
  }

  if (entry.provider === "openai-codex") {
    if (entry.kind !== "oauth-token") {
      return { ok: false, reason: `${entry.profileId}: OpenAI Codex must use oauth-token` };
    }
    const access = String(entry.oauth?.access || "").trim();
    const refresh = String(entry.oauth?.refresh || "").trim();
    if (!access || !refresh) {
      return {
        ok: false,
        reason: `${entry.profileId}: OpenAI Codex OAuth is incomplete (missing access/refresh)`,
      };
    }
    return { ok: true };
  }

  if (entry.provider === "anthropic") {
    if (entry.kind === "setup-token") {
      if (!token.startsWith("sk-ant-oat01-") || token.length < 80) {
        return { ok: false, reason: `${entry.profileId}: invalid Anthropic setup-token` };
      }
      return { ok: true };
    }
    if (entry.kind === "api-key") {
      if (!token.startsWith("sk-ant-")) {
        return { ok: false, reason: `${entry.profileId}: invalid Anthropic API key` };
      }
      return { ok: true };
    }
    return { ok: false, reason: `${entry.profileId}: unsupported Anthropic auth kind` };
  }

  if (entry.provider === "deepseek") {
    if (entry.kind !== "api-key") {
      return { ok: false, reason: `${entry.profileId}: DeepSeek must use api-key` };
    }
    if (!(token.startsWith("sk-") || token.startsWith("dsk-"))) {
      return { ok: false, reason: `${entry.profileId}: invalid DeepSeek API key` };
    }
    return { ok: true };
  }

  return { ok: false, reason: `${entry.profileId}: unknown provider` };
}

function hasAnyValidProvider(config: AppConfig): boolean {
  return config.providers.some((entry) => validateCredential(entry).ok);
}

function hasCredentialForProvider(config: AppConfig, provider: ProviderId): boolean {
  return config.providers.some((entry) => entry.provider === provider && validateCredential(entry).ok);
}

function validateModelRoleProvider(config: AppConfig, role: ModelRole, reasons: string[]): void {
  const modelRef = config.models?.[role]?.trim() || "";
  const [modelProvider] = modelRef.split("/");
  if (!modelProvider) {
    reasons.push(`Model role "${role}" is empty.`);
    return;
  }
  const providerId = mapModelProviderToProviderId(modelProvider);
  if (!providerId) {
    reasons.push(`Model role "${role}" uses unsupported provider "${modelProvider}".`);
    return;
  }
  if (!hasCredentialForProvider(config, providerId)) {
    reasons.push(`Model role "${role}" requires provider "${providerId}" auth, but no valid credential is configured.`);
  }
}

function hasModelRoles(config: AppConfig): boolean {
  const models = config.models;
  if (!models) {
    return false;
  }
  return (
    models.defaultModel.trim().length > 0 &&
    models.planningModel.trim().length > 0 &&
    models.codingModel.trim().length > 0
  );
}

function hasTelegramSetup(config: AppConfig): boolean {
  const telegram = config.telegram;
  if (!telegram.enabled) {
    return false;
  }
  if (!telegram.botToken.trim()) {
    return false;
  }
  if (telegram.accessMode === "disabled") {
    return false;
  }
  if (telegram.accessMode === "pair" && telegram.allowedChatIds.length === 0) {
    return false;
  }
  return true;
}

export function checkBasicSetup(config: AppConfig): SetupCheck {
  const reasons: string[] = [];
  if (!hasAnyValidProvider(config)) {
    reasons.push("No valid provider credentials configured.");
  }
  for (const entry of config.providers) {
    const validation = validateCredential(entry);
    if (!validation.ok && validation.reason) {
      reasons.push(validation.reason);
    }
  }
  if (!hasModelRoles(config)) {
    reasons.push("Default/planning/coding models are not configured.");
  } else {
    validateModelRoleProvider(config, "defaultModel", reasons);
    validateModelRoleProvider(config, "planningModel", reasons);
    validateModelRoleProvider(config, "codingModel", reasons);
  }
  if (!hasTelegramSetup(config)) {
    reasons.push("Telegram is not fully configured.");
  }
  return {
    ok: reasons.length === 0,
    reasons,
  };
}
