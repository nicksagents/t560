import { refreshOpenAICodexToken } from "@mariozechner/pi-ai";
import type { AppConfig } from "../config/types.js";
import { resolveProviderCredential, saveConfig, upsertProviderCredential } from "../config/store.js";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type CompletionOk = { ok: true; text: string };
type CompletionErr = {
  ok: false;
  status: number;
  code?: string;
  message: string;
  raw: string;
};
type CompletionResult = CompletionOk | CompletionErr;

function parseModelRef(modelRef: string): { provider: string; model: string } {
  const [provider, ...rest] = modelRef.split("/");
  return {
    provider: provider || "",
    model: rest.join("/") || modelRef,
  };
}

function getConfiguredModelForProvider(config: AppConfig, provider: "deepseek" | "anthropic"): string | null {
  const refs = [
    config.models?.defaultModel ?? "",
    config.models?.planningModel ?? "",
    config.models?.codingModel ?? "",
  ]
    .map((value) => String(value).trim())
    .filter(Boolean);
  for (const ref of refs) {
    if (ref.startsWith(`${provider}/`)) {
      const parsed = parseModelRef(ref);
      if (parsed.model) {
        return parsed.model;
      }
    }
  }
  return null;
}

function isQuotaError(completion: CompletionErr): boolean {
  const text = `${completion.code || ""} ${completion.message || ""} ${completion.raw || ""}`.toLowerCase();
  return (
    completion.status === 429 ||
    text.includes("insufficient_quota") ||
    text.includes("exceeded your current quota") ||
    text.includes("rate limit")
  );
}

async function tryCrossProviderFallback(config: AppConfig, messages: ChatMessage[]): Promise<string | null> {
  const deepseek = resolveProviderCredential(config, "deepseek");
  if (deepseek?.token) {
    const deepseekModel = getConfiguredModelForProvider(config, "deepseek") ?? "deepseek-chat";
    const completion = await callOpenAICompatible({
      apiBase: "https://api.deepseek.com/v1",
      token: deepseek.token,
      model: deepseekModel,
      messages,
    });
    if (completion.ok) {
      return `[Fallback deepseek/${deepseekModel}] ${completion.text}`;
    }
  }

  const anthropic = resolveProviderCredential(config, "anthropic");
  if (anthropic?.token) {
    const anthropicModel = getConfiguredModelForProvider(config, "anthropic") ?? "claude-sonnet-4-5";
    const text = await callAnthropic({
      token: anthropic.token,
      isSetupToken: anthropic.kind === "setup-token",
      model: anthropicModel,
      messages,
    });
    if (!text.startsWith("Anthropic request failed")) {
      return `[Fallback anthropic/${anthropicModel}] ${text}`;
    }
  }

  return null;
}

async function callOpenAICompatible(params: {
  apiBase: string;
  token: string;
  model: string;
  messages: ChatMessage[];
}): Promise<CompletionResult> {
  const response = await fetch(`${params.apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      temperature: 0.2,
    }),
  });

  const raw = await response.text();
  if (!response.ok) {
    try {
      const parsed = JSON.parse(raw) as {
        error?: { code?: string; message?: string; type?: string };
      };
      return {
        ok: false,
        status: response.status,
        code: parsed.error?.code,
        message: parsed.error?.message || parsed.error?.type || "provider request failed",
        raw,
      };
    } catch {
      return {
        ok: false,
        status: response.status,
        message: "provider request failed",
        raw,
      };
    }
  }
  const parsed = JSON.parse(raw) as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  };
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return { ok: true, text: content };
  }
  if (Array.isArray(content)) {
    return {
      ok: true,
      text: content
        .map((item) => item.text)
        .filter(Boolean)
        .join("\n"),
    };
  }
  return { ok: true, text: "Provider returned an empty response." };
}

async function callAnthropic(params: {
  token: string;
  isSetupToken?: boolean;
  model: string;
  messages: ChatMessage[];
}): Promise<string> {
  const conversationText = params.messages
    .slice(-12)
    .map((entry) => `${entry.role.toUpperCase()}: ${entry.content}`)
    .join("\n");

  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  if (params.isSetupToken) {
    headers.authorization = `Bearer ${params.token}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  } else {
    headers["x-api-key"] = params.token;
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: params.model,
      max_tokens: 1200,
      messages: [
        {
          role: "user",
          content: conversationText,
        },
      ],
    }),
  });

  const raw = await response.text();
  if (!response.ok) {
    return `Anthropic request failed (${response.status}): ${raw.slice(0, 300)}`;
  }

  const parsed = JSON.parse(raw) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = parsed.content?.find((item) => item.type === "text")?.text;
  return text || "Anthropic returned an empty response.";
}

async function listOpenAIModels(apiBase: string, token: string): Promise<Set<string>> {
  try {
    const response = await fetch(`${apiBase}/models`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      return new Set<string>();
    }
    const parsed = (await response.json()) as {
      data?: Array<{ id?: string }>;
    };
    const modelIds = (parsed.data ?? [])
      .map((model) => String(model.id || "").trim())
      .filter(Boolean);
    return new Set(modelIds);
  } catch {
    return new Set<string>();
  }
}

async function resolveFallbackOpenAIModel(
  apiBase: string,
  token: string,
  preferredModel: string,
): Promise<string | null> {
  const available = await listOpenAIModels(apiBase, token);
  if (available.size === 0) {
    return null;
  }
  if (available.has(preferredModel)) {
    return preferredModel;
  }
  const candidateOrder = [
    "gpt-5.3-codex",
    "gpt-5-codex",
    "gpt-5-codex-mini",
    "gpt-5",
    "gpt-5-mini",
    "gpt-4.1",
    "gpt-4o",
    "o4-mini",
  ];
  for (const candidate of candidateOrder) {
    if (available.has(candidate)) {
      return candidate;
    }
  }
  const generic = Array.from(available).find((id) => id.startsWith("gpt-") || id.startsWith("o"));
  return generic ?? null;
}

async function persistModelSwitch(
  config: AppConfig,
  oldRef: string,
  nextModelId: string,
  provider: string,
): Promise<void> {
  if (!config.models) {
    return;
  }
  const nextRef = `${provider}/${nextModelId}`;
  let changed = false;
  if (config.models.defaultModel === oldRef) {
    config.models.defaultModel = nextRef;
    changed = true;
  }
  if (config.models.planningModel === oldRef) {
    config.models.planningModel = nextRef;
    changed = true;
  }
  if (config.models.codingModel === oldRef) {
    config.models.codingModel = nextRef;
    changed = true;
  }
  if (changed) {
    await saveConfig(config);
  }
}

async function ensureOpenAICodexAccessToken(config: AppConfig): Promise<string | null> {
  const credential = resolveProviderCredential(config, "openai-codex");
  if (!credential?.token) {
    return null;
  }
  if (credential.kind !== "oauth-token") {
    return null;
  }
  if (!credential.oauth?.refresh) {
    return null;
  }

  const now = Date.now();
  const expiresAt = credential.expiresAt ?? credential.oauth.expires;
  const mustRefresh = typeof expiresAt === "number" && expiresAt > 0 && now >= expiresAt - 60_000;
  if (!mustRefresh) {
    return credential.token;
  }

  try {
    const refreshed = await refreshOpenAICodexToken(String(credential.oauth.refresh));
    const updated = {
      ...credential,
      token: String(refreshed.access || ""),
      expiresAt: Number(refreshed.expires || 0) || undefined,
      oauth: {
        ...credential.oauth,
        ...refreshed,
      },
      addedAt: new Date().toISOString(),
    };
    config.providers = upsertProviderCredential(config.providers, updated);
    await saveConfig(config);
    return updated.token;
  } catch {
    return null;
  }
}

export async function generateAssistantResponse(config: AppConfig, messages: ChatMessage[]): Promise<string> {
  const modelRef = config.models?.defaultModel?.trim();
  if (!modelRef) {
    return "No default model configured. Run `t560 onboard`.";
  }

  const parsed = parseModelRef(modelRef);
  if (parsed.provider === "deepseek") {
    const deepseek = resolveProviderCredential(config, "deepseek");
    if (!deepseek?.token) {
      return "DeepSeek is selected but no DeepSeek credential is configured.";
    }
    const completion = await callOpenAICompatible({
      apiBase: "https://api.deepseek.com/v1",
      token: deepseek.token,
      model: parsed.model,
      messages,
    });
    if (completion.ok) {
      return completion.text;
    }
    if (!completion.ok && isQuotaError(completion)) {
      const fallback = await tryCrossProviderFallback(config, messages);
      if (fallback) {
        return fallback;
      }
    }
    return `Provider request failed (${completion.status}): ${completion.raw.slice(0, 300)}`;
  }

  if (parsed.provider === "openai" || parsed.provider === "openai-codex") {
    const token = await ensureOpenAICodexAccessToken(config);
    if (!token) {
      return "OpenAI model is selected but no OpenAI Codex credential is configured.";
    }
    const apiBase = "https://api.openai.com/v1";
    const completion = await callOpenAICompatible({
      apiBase,
      token,
      model: parsed.model,
      messages,
    });
    if (completion.ok) {
      return completion.text;
    }
    if (isQuotaError(completion)) {
      const fallback = await tryCrossProviderFallback(config, messages);
      if (fallback) {
        return fallback;
      }
    }

    const modelNotFound =
      completion.status === 404 &&
      (completion.code === "model_not_found" ||
        completion.message.toLowerCase().includes("does not exist") ||
        completion.message.toLowerCase().includes("model"));
    if (modelNotFound) {
      const fallback = await resolveFallbackOpenAIModel(apiBase, token, parsed.model);
      if (fallback && fallback !== parsed.model) {
        const retried = await callOpenAICompatible({
          apiBase,
          token,
          model: fallback,
          messages,
        });
        if (retried.ok) {
          await persistModelSwitch(config, `${parsed.provider}/${parsed.model}`, fallback, parsed.provider);
          return `[Auto-switched to ${parsed.provider}/${fallback}] ${retried.text}`;
        }
      }
    }
    return `Provider request failed (${completion.status}): ${completion.raw.slice(0, 300)}`;
  }

  if (parsed.provider === "anthropic") {
    const anthropic = resolveProviderCredential(config, "anthropic");
    if (!anthropic?.token) {
      return "Anthropic model is selected but no Anthropic credential is configured.";
    }
    const response = await callAnthropic({
      token: anthropic.token,
      isSetupToken: anthropic.kind === "setup-token",
      model: parsed.model,
      messages,
    });
    if (response.startsWith("Anthropic request failed (429)")) {
      const fallback = await tryCrossProviderFallback(config, messages);
      if (fallback) {
        return fallback;
      }
    }
    return response;
  }

  return `Unknown model provider in "${modelRef}".`;
}
