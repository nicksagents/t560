// @ts-nocheck
import { getEnvApiKey } from "@mariozechner/pi-ai";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { getShellEnvAppliedKeys } from "../infra/shell-env.js";
import { normalizeOptionalSecretInput, } from "../utils/normalize-secret-input.js";
import { ensureAuthProfileStore, listProfilesForProvider, resolveApiKeyForProfile, resolveAuthProfileOrder, resolveAuthStorePathForDisplay, } from "./auth-profiles.js";
import { normalizeProviderId } from "./model-selection.js";
export { ensureAuthProfileStore, resolveAuthProfileOrder } from "./auth-profiles.js";
const AWS_BEARER_ENV = "AWS_BEARER_TOKEN_BEDROCK";
const AWS_ACCESS_KEY_ENV = "AWS_ACCESS_KEY_ID";
const AWS_SECRET_KEY_ENV = "AWS_SECRET_ACCESS_KEY";
const AWS_PROFILE_ENV = "AWS_PROFILE";
function resolveProviderConfig(cfg, provider) {
    const providers = cfg?.models?.providers ?? {};
    const direct = providers[provider];
    if (direct) {
        return direct;
    }
    const normalized = normalizeProviderId(provider);
    if (normalized === provider) {
        const matched = Object.entries(providers).find(([key]) => normalizeProviderId(key) === normalized);
        return matched?.[1];
    }
    return (providers[normalized] ??
        Object.entries(providers).find(([key]) => normalizeProviderId(key) === normalized)?.[1]);
}
export function getCustomProviderApiKey(cfg, provider) {
    const entry = resolveProviderConfig(cfg, provider);
    return normalizeOptionalSecretInput(entry?.apiKey);
}
function resolveProviderAuthOverride(cfg, provider) {
    const entry = resolveProviderConfig(cfg, provider);
    const auth = entry?.auth;
    if (auth === "api-key" || auth === "aws-sdk" || auth === "oauth" || auth === "token") {
        return auth;
    }
    return undefined;
}
function resolveEnvSourceLabel(params) {
    const shellApplied = params.envVars.some((envVar) => params.applied.has(envVar));
    const prefix = shellApplied ? "shell env: " : "env: ";
    return `${prefix}${params.label}`;
}
export function resolveAwsSdkEnvVarName(env = process.env) {
    if (env[AWS_BEARER_ENV]?.trim()) {
        return AWS_BEARER_ENV;
    }
    if (env[AWS_ACCESS_KEY_ENV]?.trim() && env[AWS_SECRET_KEY_ENV]?.trim()) {
        return AWS_ACCESS_KEY_ENV;
    }
    if (env[AWS_PROFILE_ENV]?.trim()) {
        return AWS_PROFILE_ENV;
    }
    return undefined;
}
function resolveAwsSdkAuthInfo() {
    const applied = new Set(getShellEnvAppliedKeys());
    if (process.env[AWS_BEARER_ENV]?.trim()) {
        return {
            mode: "aws-sdk",
            source: resolveEnvSourceLabel({
                applied,
                envVars: [AWS_BEARER_ENV],
                label: AWS_BEARER_ENV,
            }),
        };
    }
    if (process.env[AWS_ACCESS_KEY_ENV]?.trim() && process.env[AWS_SECRET_KEY_ENV]?.trim()) {
        return {
            mode: "aws-sdk",
            source: resolveEnvSourceLabel({
                applied,
                envVars: [AWS_ACCESS_KEY_ENV, AWS_SECRET_KEY_ENV],
                label: `${AWS_ACCESS_KEY_ENV} + ${AWS_SECRET_KEY_ENV}`,
            }),
        };
    }
    if (process.env[AWS_PROFILE_ENV]?.trim()) {
        return {
            mode: "aws-sdk",
            source: resolveEnvSourceLabel({
                applied,
                envVars: [AWS_PROFILE_ENV],
                label: AWS_PROFILE_ENV,
            }),
        };
    }
    return { mode: "aws-sdk", source: "aws-sdk default chain" };
}
export async function resolveApiKeyForProvider(params) {
    const { provider, cfg, profileId, preferredProfile } = params;
    const store = params.store ?? ensureAuthProfileStore(params.agentDir);
    if (profileId) {
        const resolved = await resolveApiKeyForProfile({
            cfg,
            store,
            profileId,
            agentDir: params.agentDir,
        });
        if (!resolved) {
            throw new Error(`No credentials found for profile "${profileId}".`);
        }
        const mode = store.profiles[profileId]?.type;
        return {
            apiKey: resolved.apiKey,
            profileId,
            source: `profile:${profileId}`,
            mode: mode === "oauth" ? "oauth" : mode === "token" ? "token" : "api-key",
        };
    }
    const authOverride = resolveProviderAuthOverride(cfg, provider);
    if (authOverride === "aws-sdk") {
        return resolveAwsSdkAuthInfo();
    }
    const order = resolveAuthProfileOrder({
        cfg,
        store,
        provider,
        preferredProfile,
    });
    for (const candidate of order) {
        try {
            const resolved = await resolveApiKeyForProfile({
                cfg,
                store,
                profileId: candidate,
                agentDir: params.agentDir,
            });
            if (resolved) {
                const mode = store.profiles[candidate]?.type;
                return {
                    apiKey: resolved.apiKey,
                    profileId: candidate,
                    source: `profile:${candidate}`,
                    mode: mode === "oauth" ? "oauth" : mode === "token" ? "token" : "api-key",
                };
            }
        }
        catch { }
    }
    const envResolved = resolveEnvApiKey(provider);
    if (envResolved) {
        return {
            apiKey: envResolved.apiKey,
            source: envResolved.source,
            mode: envResolved.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key",
        };
    }
    const customKey = getCustomProviderApiKey(cfg, provider);
    if (customKey) {
        return { apiKey: customKey, source: "models.json", mode: "api-key" };
    }
    const normalized = normalizeProviderId(provider);
    if (authOverride === undefined && normalized === "amazon-bedrock") {
        return resolveAwsSdkAuthInfo();
    }
    if (provider === "openai") {
        const hasCodex = listProfilesForProvider(store, "openai-codex").length > 0;
        if (hasCodex) {
            throw new Error('No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth. Use openai-codex/gpt-5.3-codex (OAuth) or set OPENAI_API_KEY to use openai/gpt-5.1-codex.');
        }
    }
    const authStorePath = resolveAuthStorePathForDisplay(params.agentDir);
    const resolvedAgentDir = path.dirname(authStorePath);
    throw new Error([
        `No API key found for provider "${provider}".`,
        `Auth store: ${authStorePath} (agentDir: ${resolvedAgentDir}).`,
        `Configure auth for this agent (${formatCliCommand("openclaw agents add <id>")}) or copy auth-profiles.json from the main agentDir.`,
    ].join(" "));
}
export function resolveEnvApiKey(provider) {
    const normalized = normalizeProviderId(provider);
    const applied = new Set(getShellEnvAppliedKeys());
    const pick = (envVar) => {
        const value = normalizeOptionalSecretInput(process.env[envVar]);
        if (!value) {
            return null;
        }
        const source = applied.has(envVar) ? `shell env: ${envVar}` : `env: ${envVar}`;
        return { apiKey: value, source };
    };
    if (normalized === "github-copilot") {
        return pick("COPILOT_GITHUB_TOKEN") ?? pick("GH_TOKEN") ?? pick("GITHUB_TOKEN");
    }
    if (normalized === "anthropic") {
        return pick("ANTHROPIC_OAUTH_TOKEN") ?? pick("ANTHROPIC_API_KEY");
    }
    if (normalized === "chutes") {
        return pick("CHUTES_OAUTH_TOKEN") ?? pick("CHUTES_API_KEY");
    }
    if (normalized === "zai") {
        return pick("ZAI_API_KEY") ?? pick("Z_AI_API_KEY");
    }
    if (normalized === "google-vertex") {
        const envKey = getEnvApiKey(normalized);
        if (!envKey) {
            return null;
        }
        return { apiKey: envKey, source: "gcloud adc" };
    }
    if (normalized === "opencode") {
        return pick("OPENCODE_API_KEY") ?? pick("OPENCODE_ZEN_API_KEY");
    }
    if (normalized === "qwen-portal") {
        return pick("QWEN_OAUTH_TOKEN") ?? pick("QWEN_PORTAL_API_KEY");
    }
}
