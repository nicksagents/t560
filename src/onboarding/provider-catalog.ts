export type ProviderAuthMode = "api_key" | "oauth" | "token";

export type ProviderCatalogEntry = {
  id: string;
  label: string;
  description: string;
  authModes: ProviderAuthMode[];
  authHint?: string;
  models: string[];
  defaultModel: string;
  planningModel: string;
  codingModel: string;
};

export const DEEPSEEK_CHAT_MODEL_ID = "deepseek-chat";
export const DEEPSEEK_REASONER_MODEL_ID = "deepseek-reasoner";
export const DEEPSEEK_CANONICAL_MODEL_IDS = [
  DEEPSEEK_CHAT_MODEL_ID,
  DEEPSEEK_REASONER_MODEL_ID,
] as const;

const DEEPSEEK_MODEL_ALIAS_MAP: Record<string, (typeof DEEPSEEK_CANONICAL_MODEL_IDS)[number]> = {
  "deepseek-chat": DEEPSEEK_CHAT_MODEL_ID,
  "deepseek-v3": DEEPSEEK_CHAT_MODEL_ID,
  "deepseek-v3-0324": DEEPSEEK_CHAT_MODEL_ID,
  "deepseek-v3.1": DEEPSEEK_CHAT_MODEL_ID,
  "deepseek-v3.1-terminus": DEEPSEEK_CHAT_MODEL_ID,
  "deepseek-v3.2": DEEPSEEK_CHAT_MODEL_ID,
  "deepseek-v3.2-exp": DEEPSEEK_CHAT_MODEL_ID,
  "deepseek-reasoner": DEEPSEEK_REASONER_MODEL_ID,
  "deepseek-r1": DEEPSEEK_REASONER_MODEL_ID,
  "deepseek-r1-0528": DEEPSEEK_REASONER_MODEL_ID,
};

function uniqModelIds(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const modelId = String(raw ?? "").trim();
    if (!modelId) {
      continue;
    }
    const key = modelId.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(modelId);
  }
  return out;
}

export function normalizeProviderModels(providerId: string, models: string[]): string[] {
  const normalizedProviderId = String(providerId ?? "").trim().toLowerCase();
  const compact = uniqModelIds(models);
  if (normalizedProviderId !== "deepseek") {
    return compact;
  }

  const out: string[] = [...DEEPSEEK_CANONICAL_MODEL_IDS];
  const seen = new Set<string>(out.map((modelId) => modelId.toLowerCase()));
  for (const modelId of compact) {
    const normalized = DEEPSEEK_MODEL_ALIAS_MAP[modelId.toLowerCase()] ?? modelId;
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

const CATALOG: ProviderCatalogEntry[] = [
  {
    id: "openai-codex",
    label: "OpenAI Codex",
    description: "OpenAI Codex OAuth/API provider",
    authModes: ["oauth", "api_key"],
    authHint: "Use OAuth for OpenAI Codex, or provide an API key.",
    models: [
      "gpt-5.1-codex-mini",
      "gpt-5.1-codex",
      "gpt-5.2-codex",
      "gpt-5.3-codex",
    ],
    defaultModel: "gpt-5.1-codex-mini",
    planningModel: "gpt-5.1-codex-mini",
    codingModel: "gpt-5.1-codex",
  },
  {
    id: "openai",
    label: "OpenAI-Compatible",
    description: "OpenAI API or compatible endpoint",
    authModes: ["api_key"],
    authHint:
      "You can set a custom API endpoint URL during onboarding.",
    models: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-5-mini"],
    defaultModel: "gpt-4o-mini",
    planningModel: "gpt-4o-mini",
    codingModel: "gpt-4.1-mini",
  },
  {
    id: "local-openai",
    label: "Local Model",
    description: "Local AI server: llama.cpp, exo, ollama, or any OpenAI-compatible endpoint on your machine",
    authModes: ["api_key"],
    authHint:
      "Enter your server URL (e.g. http://127.0.0.1:8080/v1 for llama.cpp, http://127.0.0.1:52415/v1 for exo, http://127.0.0.1:11434/v1 for ollama). API key is optional — most local servers don't require one.",
    models: ["local-model"],
    defaultModel: "local-model",
    planningModel: "local-model",
    codingModel: "local-model",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    description: "Claude models via Claude Code CLI auth token or API key",
    authModes: ["token", "api_key", "oauth"],
    authHint:
      "Recommended: get a Claude Code auth token by running 'claude setup-token' in your terminal (requires Claude Code CLI installed and logged in via 'claude auth login'). Or use an API key from console.anthropic.com/settings/keys.",
    models: ["claude-sonnet-4-5", "claude-opus-4-6"],
    defaultModel: "claude-sonnet-4-5",
    planningModel: "claude-sonnet-4-5",
    codingModel: "claude-sonnet-4-5",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "OpenRouter model gateway",
    authModes: ["api_key"],
    models: ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet"],
    defaultModel: "openai/gpt-4o-mini",
    planningModel: "openai/gpt-4o-mini",
    codingModel: "openai/gpt-4o-mini",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek API (V3.2 chat + reasoning modes)",
    authModes: ["api_key"],
    models: [...DEEPSEEK_CANONICAL_MODEL_IDS],
    defaultModel: DEEPSEEK_CHAT_MODEL_ID,
    planningModel: DEEPSEEK_REASONER_MODEL_ID,
    codingModel: DEEPSEEK_CHAT_MODEL_ID,
  },
];

export function listProviderCatalog(): ProviderCatalogEntry[] {
  return CATALOG.map((entry) => ({
    ...entry,
    models: [...entry.models],
  }));
}

export function getProviderCatalogEntry(id: string): ProviderCatalogEntry | undefined {
  return CATALOG.find((entry) => entry.id === id);
}
