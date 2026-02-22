// @ts-nocheck
import { ensureAuthProfileStore, resolveAuthProfileOrder } from "../agents/auth-profiles.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import { formatApiKeyPreview, normalizeApiKeyInput, validateApiKeyInput, } from "./auth-choice.api-key.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import { applyAuthProfileConfig, applyOpenrouterConfig, applyOpenrouterProviderConfig, OPENROUTER_DEFAULT_MODEL_REF, setOpenrouterApiKey, setVercelAiGatewayApiKey, } from "./onboard-auth.js";
export async function applyAuthChoiceApiProviders(params) {
    let nextConfig = params.config;
    let agentModelOverride;
    const noteAgentModel = async (model) => {
        if (!params.agentId) {
            return;
        }
        await params.prompter.note(`Default model set to ${model} for agent "${params.agentId}".`, "Model configured");
    };
    let authChoice = params.authChoice;
    if (authChoice === "apiKey" &&
        params.opts?.tokenProvider &&
        params.opts.tokenProvider !== "anthropic" &&
        params.opts.tokenProvider !== "openai") {
        if (params.opts.tokenProvider === "openrouter") {
            authChoice = "openrouter-api-key";
        }
        else if (params.opts.tokenProvider === "vercel-ai-gateway") {
            authChoice = "ai-gateway-api-key";
        }
        else if (params.opts.tokenProvider === "cloudflare-ai-gateway") {
            authChoice = "cloudflare-ai-gateway-api-key";
        }
        else if (params.opts.tokenProvider === "moonshot") {
            authChoice = "moonshot-api-key";
        }
        else if (params.opts.tokenProvider === "kimi-code" ||
            params.opts.tokenProvider === "kimi-coding") {
            authChoice = "kimi-code-api-key";
        }
        else if (params.opts.tokenProvider === "google") {
            authChoice = "gemini-api-key";
        }
        else if (params.opts.tokenProvider === "zai") {
            authChoice = "zai-api-key";
        }
        else if (params.opts.tokenProvider === "xiaomi") {
            authChoice = "xiaomi-api-key";
        }
        else if (params.opts.tokenProvider === "synthetic") {
            authChoice = "synthetic-api-key";
        }
        else if (params.opts.tokenProvider === "venice") {
            authChoice = "venice-api-key";
        }
        else if (params.opts.tokenProvider === "together") {
            authChoice = "together-api-key";
        }
        else if (params.opts.tokenProvider === "opencode") {
            authChoice = "opencode-zen";
        }
        else if (params.opts.tokenProvider === "qianfan") {
            authChoice = "qianfan-api-key";
        }
    }
    if (authChoice === "openrouter-api-key") {
        const store = ensureAuthProfileStore(params.agentDir, {
            allowKeychainPrompt: false,
        });
        const profileOrder = resolveAuthProfileOrder({
            cfg: nextConfig,
            store,
            provider: "openrouter",
        });
        const existingProfileId = profileOrder.find((profileId) => Boolean(store.profiles[profileId]));
        const existingCred = existingProfileId ? store.profiles[existingProfileId] : undefined;
        let profileId = "openrouter:default";
        let mode = "api_key";
        let hasCredential = false;
        if (existingProfileId && existingCred?.type) {
            profileId = existingProfileId;
            mode =
                existingCred.type === "oauth"
                    ? "oauth"
                    : existingCred.type === "token"
                        ? "token"
                        : "api_key";
            hasCredential = true;
        }
        if (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "openrouter") {
            await setOpenrouterApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir);
            hasCredential = true;
        }
        if (!hasCredential) {
            const envKey = resolveEnvApiKey("openrouter");
            if (envKey) {
                const useExisting = await params.prompter.confirm({
                    message: `Use existing OPENROUTER_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
                    initialValue: true,
                });
                if (useExisting) {
                    await setOpenrouterApiKey(envKey.apiKey, params.agentDir);
                    hasCredential = true;
                }
            }
        }
        if (!hasCredential) {
            const key = await params.prompter.text({
                message: "Enter OpenRouter API key",
                validate: validateApiKeyInput,
            });
            await setOpenrouterApiKey(normalizeApiKeyInput(String(key)), params.agentDir);
            hasCredential = true;
        }
        if (hasCredential) {
            nextConfig = applyAuthProfileConfig(nextConfig, {
                profileId,
                provider: "openrouter",
                mode,
            });
        }
        {
            const applied = await applyDefaultModelChoice({
                config: nextConfig,
                setDefaultModel: params.setDefaultModel,
                defaultModel: OPENROUTER_DEFAULT_MODEL_REF,
                applyDefaultConfig: applyOpenrouterConfig,
                applyProviderConfig: applyOpenrouterProviderConfig,
                noteDefault: OPENROUTER_DEFAULT_MODEL_REF,
                noteAgentModel,
                prompter: params.prompter,
            });
            nextConfig = applied.config;
            agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
        }
        return { config: nextConfig, agentModelOverride };
    }
    if (authChoice === "ai-gateway-api-key") {
        let hasCredential = false;
        if (!hasCredential &&
            params.opts?.token &&
            params.opts?.tokenProvider === "vercel-ai-gateway") {
            await setVercelAiGatewayApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir);
            hasCredential = true;
        }
        const envKey = resolveEnvApiKey("vercel-ai-gateway");
        if (envKey) {
            const useExisting = await params.prompter.confirm({
                message: `Use existing AI_GATEWAY_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
                initialValue: true,
            });
            if (useExisting) {
                await setVercelAiGatewayApiKey(envKey.apiKey, params.agentDir);
                hasCredential = true;
            }
        }
    }
}
