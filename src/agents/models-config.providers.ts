// @ts-nocheck
import { ensureAuthProfileStore, listProfilesForProvider } from "./auth-profiles.js";
import { resolveAwsSdkEnvVarName, resolveEnvApiKey } from "./model-auth.js";
const MINIMAX_API_BASE_URL = "https://api.minimax.chat/v1";
const MINIMAX_PORTAL_BASE_URL = "https://api.minimax.io/anthropic";
const MINIMAX_DEFAULT_MODEL_ID = "MiniMax-M2.1";
const MINIMAX_DEFAULT_VISION_MODEL_ID = "MiniMax-VL-01";
const MINIMAX_DEFAULT_CONTEXT_WINDOW = 200000;
const MINIMAX_DEFAULT_MAX_TOKENS = 8192;
const MINIMAX_OAUTH_PLACEHOLDER = "minimax-oauth";
// Pricing: MiniMax doesn't publish public rates. Override in models.json for accurate costs.
const MINIMAX_API_COST = {
    input: 15,
    output: 60,
    cacheRead: 2,
    cacheWrite: 10,
};
const XIAOMI_BASE_URL = "https://api.xiaomimimo.com/anthropic";
export const XIAOMI_DEFAULT_MODEL_ID = "mimo-v2-flash";
const XIAOMI_DEFAULT_CONTEXT_WINDOW = 262144;
const XIAOMI_DEFAULT_MAX_TOKENS = 8192;
const XIAOMI_DEFAULT_COST = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
};
const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
const MOONSHOT_DEFAULT_MODEL_ID = "kimi-k2.5";
const MOONSHOT_DEFAULT_CONTEXT_WINDOW = 256000;
const MOONSHOT_DEFAULT_MAX_TOKENS = 8192;
const MOONSHOT_DEFAULT_COST = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
};
const QWEN_PORTAL_BASE_URL = "https://portal.qwen.ai/v1";
const QWEN_PORTAL_OAUTH_PLACEHOLDER = "qwen-oauth";
const QWEN_PORTAL_DEFAULT_CONTEXT_WINDOW = 128000;
const QWEN_PORTAL_DEFAULT_MAX_TOKENS = 8192;
const QWEN_PORTAL_DEFAULT_COST = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
};
const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
const OLLAMA_API_BASE_URL = "http://127.0.0.1:11434";
const OLLAMA_DEFAULT_CONTEXT_WINDOW = 128000;
const OLLAMA_DEFAULT_MAX_TOKENS = 8192;
const OLLAMA_DEFAULT_COST = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
};
export const QIANFAN_BASE_URL = "https://qianfan.baidubce.com/v2";
export const QIANFAN_DEFAULT_MODEL_ID = "deepseek-v3.2";
const QIANFAN_DEFAULT_CONTEXT_WINDOW = 98304;
const QIANFAN_DEFAULT_MAX_TOKENS = 32768;
const QIANFAN_DEFAULT_COST = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
};
async function discoverOllamaModels() {
    // Skip Ollama discovery in test environments
    if (process.env.VITEST || process.env.NODE_ENV === "test") {
        return [];
    }
    try {
        const response = await fetch(`${OLLAMA_API_BASE_URL}/api/tags`, {
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
            console.warn(`Failed to discover Ollama models: ${response.status}`);
            return [];
        }
        const data = (await response.json());
        if (!data.models || data.models.length === 0) {
            console.warn("No Ollama models found on local instance");
            return [];
        }
        return data.models.map((model) => {
            const modelId = model.name;
            const isReasoning = modelId.toLowerCase().includes("r1") || modelId.toLowerCase().includes("reasoning");
            return {
                id: modelId,
                name: modelId,
                reasoning: isReasoning,
                input: ["text"],
                cost: OLLAMA_DEFAULT_COST,
                contextWindow: OLLAMA_DEFAULT_CONTEXT_WINDOW,
                maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
                // Disable streaming by default for Ollama to avoid SDK issue #1205
                // See: https://github.com/badlogic/pi-mono/issues/1205
                params: {
                    streaming: false,
                },
            };
        });
    }
    catch (error) {
        console.warn(`Failed to discover Ollama models: ${String(error)}`);
        return [];
    }
}
function normalizeApiKeyConfig(value) {
    const trimmed = value.trim();
    const match = /^\$\{([A-Z0-9_]+)\}$/.exec(trimmed);
    return match?.[1] ?? trimmed;
}
function resolveEnvApiKeyVarName(provider) {
    const resolved = resolveEnvApiKey(provider);
    if (!resolved) {
        return undefined;
    }
    const match = /^(?:env: |shell env: )([A-Z0-9_]+)$/.exec(resolved.source);
    return match ? match[1] : undefined;
}
function resolveAwsSdkApiKeyVarName() {
    return resolveAwsSdkEnvVarName() ?? "AWS_PROFILE";
}
function resolveApiKeyFromProfiles(params) {
    const ids = listProfilesForProvider(params.store, params.provider);
    for (const id of ids) {
        const cred = params.store.profiles[id];
        if (!cred) {
            continue;
        }
        if (cred.type === "api_key") {
            return cred.key;
        }
        if (cred.type === "token") {
            return cred.token;
        }
    }
    return undefined;
}
export function normalizeGoogleModelId(id) {
    if (id === "gemini-3-pro") {
        return "gemini-3-pro-preview";
    }
    if (id === "gemini-3-flash") {
        return "gemini-3-flash-preview";
    }
    return id;
}
function normalizeGoogleProvider(provider) {
    let mutated = false;
    const models = provider.models.map((model) => {
        const nextId = normalizeGoogleModelId(model.id);
        if (nextId === model.id) {
            return model;
        }
        mutated = true;
        return { ...model, id: nextId };
    });
    return mutated ? { ...provider, models } : provider;
}
export function normalizeProviders(params) {
    const { providers } = params;
    if (!providers) {
        return providers;
    }
    const authStore = ensureAuthProfileStore(params.agentDir, {
        allowKeychainPrompt: false,
    });
    let mutated = false;
    const next = {};
    for (const [key, provider] of Object.entries(providers)) {
        const normalizedKey = key.trim();
        let normalizedProvider = provider;
        // Fix common misconfig: apiKey set to "${ENV_VAR}" instead of "ENV_VAR".
        if (normalizedProvider.apiKey &&
            normalizeApiKeyConfig(normalizedProvider.apiKey) !== normalizedProvider.apiKey) {
            mutated = true;
            normalizedProvider = {
                ...normalizedProvider,
                apiKey: normalizeApiKeyConfig(normalizedProvider.apiKey),
            };
        }
        // If a provider defines models, pi's ModelRegistry requires apiKey to be set.
        // Fill it from the environment or auth profiles when possible.
        const hasModels = Array.isArray(normalizedProvider.models) && normalizedProvider.models.length > 0;
        if (hasModels && !normalizedProvider.apiKey?.trim()) {
            const authMode = normalizedProvider.auth ?? (normalizedKey === "amazon-bedrock" ? "aws-sdk" : undefined);
            if (authMode === "aws-sdk") {
                const apiKey = resolveAwsSdkApiKeyVarName();
                mutated = true;
                normalizedProvider = { ...normalizedProvider, apiKey };
            }
            else {
                const fromEnv = resolveEnvApiKeyVarName(normalizedKey);
                const fromProfiles = resolveApiKeyFromProfiles({
                    provider: normalizedKey,
                    store: authStore,
                });
                const apiKey = fromEnv ?? fromProfiles;
                if (apiKey?.trim()) {
                    mutated = true;
                    normalizedProvider = { ...normalizedProvider, apiKey };
                }
            }
        }
        if (normalizedKey === "google") {
            const googleNormalized = normalizeGoogleProvider(normalizedProvider);
            if (googleNormalized !== normalizedProvider) {
                mutated = true;
            }
            normalizedProvider = googleNormalized;
        }
        next[key] = normalizedProvider;
    }
    return mutated ? next : providers;
}
function buildMinimaxProvider() {
    return {
        baseUrl: MINIMAX_API_BASE_URL,
        api: "openai-completions",
        models: [
            {
                id: MINIMAX_DEFAULT_MODEL_ID,
                name: "MiniMax M2.1",
                reasoning: false,
                input: ["text"],
                cost: MINIMAX_API_COST,
                contextWindow: MINIMAX_DEFAULT_CONTEXT_WINDOW,
                maxTokens: MINIMAX_DEFAULT_MAX_TOKENS,
            },
            {
                id: MINIMAX_DEFAULT_VISION_MODEL_ID,
                name: "MiniMax VL 01",
                reasoning: false,
                input: ["text", "image"],
                cost: MINIMAX_API_COST,
                contextWindow: MINIMAX_DEFAULT_CONTEXT_WINDOW,
                maxTokens: MINIMAX_DEFAULT_MAX_TOKENS,
            },
        ],
    };
}
function buildMinimaxPortalProvider() {
    return {
        baseUrl: MINIMAX_PORTAL_BASE_URL,
        api: "anthropic-messages",
        models: [
            {}
        ]
    };
}
