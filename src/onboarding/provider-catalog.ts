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
    label: "Local OpenAI",
    description: "Self-hosted OpenAI-compatible model endpoint",
    authModes: ["api_key"],
    authHint:
      "Use any non-empty key if your local server ignores auth. You will be prompted for endpoint URL.",
    models: ["local-model"],
    defaultModel: "local-model",
    planningModel: "local-model",
    codingModel: "local-model",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    description: "Claude models",
    authModes: ["api_key", "oauth", "token"],
    authHint: "Use API key, OAuth token, or setup token depending on your Anthropic account/workflow.",
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
    description: "DeepSeek API",
    authModes: ["api_key"],
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat",
    planningModel: "deepseek-reasoner",
    codingModel: "deepseek-chat",
  },
];

export function listProviderCatalog(): ProviderCatalogEntry[] {
  return [...CATALOG];
}

export function getProviderCatalogEntry(id: string): ProviderCatalogEntry | undefined {
  return CATALOG.find((entry) => entry.id === id);
}
