import { readFile } from "node:fs/promises";
import {
  complete,
  getModel,
  getModels,
  getProviders,
  type Api,
  type AssistantMessage,
  type Context,
  type KnownProvider,
  type Message
} from "@mariozechner/pi-ai";
import type { GatewayChannelId } from "../gateway/types.js";
import {
  resolveLegacyUserPath,
  resolveBootstrapMaxChars,
  resolveSoulPath,
  resolveUsersPath,
  type ProviderProfile,
  type RoutingTarget,
  type T560Config
} from "../config/state.js";
import { loadSessionMessages, saveSessionMessages } from "./session.js";
import { createT560CodingTools } from "../agents/pi-tools.js";
import { loadT560BootstrapContext } from "../agents/bootstrap-context.js";
import { executeToolCall, toToolDefinitions } from "../agents/pi-tool-definition-adapter.js";
import { normalizeToolParameters } from "../agents/pi-tools.schema.js";
import { resolveSkillsPromptForRun } from "../agents/skills.js";
import { buildAgentSystemPrompt } from "../agents/system-prompt.js";
import { emitAgentEvent } from "../agents/agent-events.js";

type ProviderChatParams = {
  config: T560Config;
  target: RoutingTarget;
  message: string;
  sessionId?: string;
  externalUserId: string;
  channel: GatewayChannelId;
};

type ProviderChatResult = {
  message: string;
  thinking: string | null;
  toolCalls: string[];
  provider: string;
  model: string;
};

/** Compatibility hook; prompt files are now read fresh each run. */
export function bustSoulPromptCache(): void {}

/** Compatibility hook; prompt files are now read fresh each run. */
export function bustUsersPromptCache(): void {}

const SUPPORTED_PROVIDERS = new Set<string>(getProviders());
const MAX_TOOL_ROUNDS = 12;
const TOOL_ERROR_PREVIEW_MAX_CHARS = 240;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
const MIN_PROVIDER_TIMEOUT_MS = 5_000;
const MAX_PROVIDER_TIMEOUT_MS = 15 * 60_000;

function resolveProviderTimeoutMs(): number {
  const rawSec = Number(process.env.T560_PROVIDER_TIMEOUT_SEC ?? "");
  if (Number.isFinite(rawSec) && rawSec > 0) {
    return Math.min(MAX_PROVIDER_TIMEOUT_MS, Math.max(MIN_PROVIDER_TIMEOUT_MS, Math.floor(rawSec * 1000)));
  }
  const rawMs = Number(process.env.T560_PROVIDER_TIMEOUT_MS ?? "");
  if (Number.isFinite(rawMs) && rawMs > 0) {
    return Math.min(MAX_PROVIDER_TIMEOUT_MS, Math.max(MIN_PROVIDER_TIMEOUT_MS, Math.floor(rawMs)));
  }
  return DEFAULT_PROVIDER_TIMEOUT_MS;
}

function assertSupportedProvider(provider: string): KnownProvider {
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(`Provider '${provider}' is not supported by the provider runtime.`);
  }
  return provider as KnownProvider;
}

async function loadTextFile(path: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, "utf-8");
    const trimmed = raw.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

type LoadedProfilePrompt = {
  path: string;
  content?: string;
};

async function loadSoulPrompt(): Promise<LoadedProfilePrompt> {
  const soulPath = resolveSoulPath();
  return {
    path: soulPath,
    content: await loadTextFile(soulPath)
  };
}

async function loadUsersPrompt(): Promise<LoadedProfilePrompt> {
  const usersPath = resolveUsersPath();
  const preferred = await loadTextFile(usersPath);
  if (preferred) {
    return {
      path: usersPath,
      content: preferred
    };
  }

  const legacyPath = resolveLegacyUserPath();
  const fallback = await loadTextFile(legacyPath);
  return {
    path: fallback ? legacyPath : usersPath,
    content: fallback
  };
}

function extractCredential(profile: ProviderProfile): string | undefined {
  if (profile.apiKey) {
    return profile.apiKey;
  }
  if (profile.token) {
    return profile.token;
  }
  if (profile.oauthToken) {
    return profile.oauthToken;
  }
  return undefined;
}

type FlattenedMessage = {
  text: string;
  thinking: string | null;
  toolCalls: string[];
};

function flattenAssistantMessage(message: AssistantMessage): FlattenedMessage {
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: string[] = [];

  for (const block of message.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "thinking") {
      thinkingParts.push(block.thinking);
    } else if (block.type === "toolCall") {
      toolCalls.push(block.name);
    }
  }

  return {
    text: textParts.filter(Boolean).join("\n\n").trim(),
    thinking: thinkingParts.length > 0 ? thinkingParts.join("\n").trim() : null,
    toolCalls
  };
}

function getModelsSafe(provider: KnownProvider): string[] {
  try {
    return getModels(provider).map((m) => m.id);
  } catch {
    return [];
  }
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function isCustomOpenAIBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return false;
  }
  return !/^https?:\/\/api\.openai\.com(?:\/v1)?\/?$/i.test(baseUrl);
}

function resolveModelApi(params: {
  provider: KnownProvider;
  profile: ProviderProfile;
  templateApi: Api;
  baseUrl?: string;
}): Api {
  const configuredApi = params.profile.api?.trim();
  if (configuredApi) {
    return configuredApi as Api;
  }
  if (params.provider === "openai" && isCustomOpenAIBaseUrl(params.baseUrl)) {
    // Most local OpenAI-compatible servers expose /chat/completions, not /responses.
    return "openai-completions";
  }
  return params.templateApi;
}

function applyProfileModelOverrides(params: {
  provider: KnownProvider;
  profile: ProviderProfile;
  modelDef: ReturnType<typeof getModel>;
}): ReturnType<typeof getModel> {
  const { provider, profile } = params;
  const modelDef = params.modelDef as Record<string, unknown>;
  const baseUrl = normalizeBaseUrl(profile.baseUrl);
  const api = resolveModelApi({
    provider,
    profile,
    templateApi: String(modelDef.api ?? "openai-responses") as Api,
    baseUrl,
  });
  const compat = profile.compat ?? modelDef.compat;
  const headers = profile.headers ?? (modelDef.headers as Record<string, string> | undefined);

  if (!baseUrl && !profile.api && !headers && !profile.compat) {
    return params.modelDef;
  }

  return {
    ...(params.modelDef as Record<string, unknown>),
    ...(baseUrl ? { baseUrl } : {}),
    api,
    ...(headers ? { headers } : {}),
    ...(compat ? { compat } : {}),
  } as ReturnType<typeof getModel>;
}

function buildCustomModelDefinition(params: {
  provider: KnownProvider;
  profile: ProviderProfile;
  modelId: string;
}): ReturnType<typeof getModel> | undefined {
  const templates = getModels(params.provider);
  const template = templates[0];
  if (!template) {
    return undefined;
  }

  const baseUrl = normalizeBaseUrl(params.profile.baseUrl) ?? template.baseUrl;
  const api = resolveModelApi({
    provider: params.provider,
    profile: params.profile,
    templateApi: template.api,
    baseUrl,
  });

  return {
    ...(template as Record<string, unknown>),
    id: params.modelId,
    name: params.modelId,
    provider: params.provider,
    baseUrl,
    api,
    ...(params.profile.headers ? { headers: params.profile.headers } : {}),
    ...(params.profile.compat ? { compat: params.profile.compat } : {}),
  } as ReturnType<typeof getModel>;
}

function resolveModelAlias(provider: KnownProvider, modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return modelId;
  }
  const canonical = trimmed.toLowerCase();

  if (provider === "openai-codex") {
    if (canonical === "gpt-5-mini" || canonical === "gpt-s-mini") {
      return "gpt-5.1-codex-mini";
    }
    if (canonical === "gpt-5" || canonical === "gpt-5-codex") {
      return "gpt-5.1-codex-mini";
    }
  }

  return trimmed;
}

function summarizeToolContent(content: string): string {
  const line = content
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  const first = line || content.trim() || "(empty error)";
  return first.length > TOOL_ERROR_PREVIEW_MAX_CHARS
    ? `${first.slice(0, TOOL_ERROR_PREVIEW_MAX_CHARS)}...`
    : first;
}

function requestLikelyNeedsTools(message: string): boolean {
  const text = message.toLowerCase();
  return (
    /\b(create|make|write|edit|delete|remove|rename|move|copy)\b/.test(text) ||
    /\b(file|folder|directory|desktop|documents|downloads)\b/.test(text) ||
    /\b(run|execute|install|uninstall|start|stop|restart)\b/.test(text) ||
    /\bterminal|shell|command|bash|cd|ls|pwd|cat|npm|pnpm|yarn|git\b/.test(text) ||
    /\b(search|look up|lookup|latest|current|today|news|web|internet|url|website|source)\b/.test(
      text,
    ) ||
    /\b(open|click|navigate|browse|tab|page|site|scrape|crawl)\b/.test(text)
  );
}

const SMALL_TALK_MESSAGES = new Set<string>([
  "hi",
  "hello",
  "hey",
  "hey there",
  "hi there",
  "hello there",
  "yo",
  "sup",
  "what's up",
  "whats up",
  "good morning",
  "good afternoon",
  "good evening",
  "good night",
  "how are you",
  "thanks",
  "thank you",
  "thx",
  "ok",
  "okay",
  "cool",
  "nice",
  "ping",
]);

function normalizeSimpleMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSmallTalkMessage(message: string): boolean {
  const normalized = normalizeSimpleMessage(message);
  if (!normalized) {
    return false;
  }
  if (normalized.split(" ").length > 4) {
    return false;
  }
  return SMALL_TALK_MESSAGES.has(normalized);
}

export async function chatWithProvider(params: ProviderChatParams): Promise<ProviderChatResult> {
  const provider = params.target.provider;
  const model = params.target.model;
  if (!provider || !model) {
    throw new Error("Provider route is missing provider or model.");
  }

  const profile = params.config.providers?.[provider];
  if (!profile) {
    throw new Error(`Provider '${provider}' is not configured.`);
  }

  const credential = extractCredential(profile);
  const normalizedBaseUrl = normalizeBaseUrl(profile.baseUrl);
  const allowMissingCredential = Boolean(
    normalizedBaseUrl && (profile.provider === "openai" || provider === "local-openai"),
  );
  if (!credential && !allowMissingCredential) {
    throw new Error(`Credentials missing for provider '${provider}'.`);
  }

  const runtimeProvider = profile.provider || provider;
  const typedProvider = assertSupportedProvider(runtimeProvider);

  const sessionId = params.sessionId || params.externalUserId || "default";
  const history = await loadSessionMessages(sessionId);
  const userMessage: Message = {
    role: "user",
    content: params.message,
    timestamp: Date.now()
  };

  const resolvedModelId = resolveModelAlias(typedProvider, model);
  const discovered = getModel(typedProvider, resolvedModelId as never);
  let modelDef = discovered
    ? applyProfileModelOverrides({
        provider: typedProvider,
        profile,
        modelDef: discovered,
      })
    : undefined;

  if (!modelDef) {
    modelDef = buildCustomModelDefinition({
      provider: typedProvider,
      profile,
      modelId: resolvedModelId,
    });
  }

  if (!modelDef) {
    const available = getModelsSafe(typedProvider);
    const hint = available.length ? ` Available models: ${available.join(", ")}.` : "";
    throw new Error(
      `Model '${model}' not found for provider '${typedProvider}'.${hint}`
    );
  }

  const smallTalkTurn = isSmallTalkMessage(params.message);
  const tools = smallTalkTurn
    ? []
    : createT560CodingTools({
        workspaceDir: process.cwd(),
        config: params.config,
        modelProvider: typedProvider,
        senderIsOwner: true
      });
  const toolDefinitions = normalizeToolParameters(toToolDefinitions(tools));

  const soulPrompt = await loadSoulPrompt();
  const usersPrompt = await loadUsersPrompt();
  if (!soulPrompt.content) {
    throw new Error("soul.md is missing or empty. Run `t560 onboard` to restore profile context.");
  }
  if (!usersPrompt.content) {
    throw new Error("users.md/user.md is missing or empty. Run `t560 onboard` to restore profile context.");
  }
  const skillsPrompt = await resolveSkillsPromptForRun({
    workspaceDir: process.cwd(),
    config: params.config
  });
  const injectedContextFiles = await loadT560BootstrapContext({
    workspaceDir: process.cwd(),
    maxChars: resolveBootstrapMaxChars(params.config),
    soulFallback: {
      path: soulPrompt.path,
      content: soulPrompt.content
    },
    userFallback: {
      path: usersPrompt.path,
      content: usersPrompt.content
    }
  });

  const systemPrompt = buildAgentSystemPrompt({
    workspaceDir: process.cwd(),
    skillsPrompt,
    injectedContextFiles,
    toolNames: tools.map((tool) => tool.name)
  });

  emitAgentEvent({
    stream: "status",
    sessionId,
    channel: params.channel,
    timestamp: Date.now(),
    data: {
      phase: "provider",
      provider: typedProvider,
      model: resolvedModelId
    }
  });

  const messages: Message[] = [...history, userMessage];
  const allToolCalls: string[] = [];
  const toolOutcomes: Array<{
    toolName: string;
    isError: boolean;
    content: string;
  }> = [];
  let lastAssistant: AssistantMessage | undefined;
  const forceToolUse = !smallTalkTurn && requestLikelyNeedsTools(params.message);
  const providerTimeoutMs = resolveProviderTimeoutMs();
  const modelBaseUrl =
    typeof (modelDef as { baseUrl?: unknown }).baseUrl === "string"
      ? (modelDef as { baseUrl: string }).baseUrl
      : "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const context: Context = {
      systemPrompt,
      tools: toolDefinitions,
      messages
    };

    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
    }, providerTimeoutMs);
    timeout.unref?.();
    let assistant: AssistantMessage;
    try {
      assistant = await complete(modelDef, context, {
        ...(credential ? { apiKey: credential } : {}),
        ...(profile.headers && Object.keys(profile.headers).length > 0
          ? { headers: profile.headers }
          : {}),
        sessionId,
        signal: abortController.signal,
        metadata: {
          channel: params.channel,
          userId: params.externalUserId
        }
      });
    } catch (error: unknown) {
      if (abortController.signal.aborted) {
        const endpointHint = modelBaseUrl ? ` endpoint=${modelBaseUrl}` : "";
        throw new Error(
          `Provider request timed out after ${Math.round(providerTimeoutMs / 1000)}s.${endpointHint}`
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    messages.push(assistant);
    lastAssistant = assistant;

    const toolCalls = assistant.content.filter(
      (block): block is Extract<AssistantMessage["content"][number], { type: "toolCall" }> =>
        block.type === "toolCall"
    );

    if (toolCalls.length === 0) {
      if (round === 0 && forceToolUse) {
        messages.push({
          role: "user",
          content:
            "System instruction: this request requires real tool execution. Use tools now and only report verified outcomes from tool results.",
          timestamp: Date.now()
        });
        continue;
      }
      break;
    }

    for (const toolCall of toolCalls) {
      allToolCalls.push(toolCall.name);
      const outcome = await executeToolCall({
        tools,
        toolDefinitions,
        toolCall,
        context: {
          sessionId,
          channel: params.channel,
          provider: typedProvider,
          model: resolvedModelId
        }
      });
      toolOutcomes.push({
        toolName: toolCall.name,
        isError: outcome.isError,
        content: outcome.content
      });

      messages.push({
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: outcome.content }],
        isError: outcome.isError,
        timestamp: Date.now()
      });
    }
  }

  if (!lastAssistant) {
    throw new Error("Provider did not return an assistant response.");
  }

  await saveSessionMessages(sessionId, messages);

  const flattened = flattenAssistantMessage(lastAssistant);
  const failedToolOutcomes = toolOutcomes.filter((entry) => entry.isError);
  const successfulToolOutcomes = toolOutcomes.filter((entry) => !entry.isError);
  const errorSummary =
    failedToolOutcomes.length > 0
      ? failedToolOutcomes
          .slice(0, 4)
          .map((entry) => `- ${entry.toolName}: ${summarizeToolContent(entry.content)}`)
          .join("\n")
      : "";
  const successSummary =
    successfulToolOutcomes.length > 0
      ? `Successful tool calls: ${successfulToolOutcomes.map((entry) => entry.toolName).join(", ")}`
      : "";
  let message = flattened.text || "(empty response)";

  if (forceToolUse && allToolCalls.length === 0) {
    message = [
      "I could not complete this action because no tools were executed.",
      "I will only claim completion after real tool execution confirms results."
    ].join("\n");
  }

  if (failedToolOutcomes.length > 0) {
    const lines = [
      "I completed this request with tool failures, so you should not trust any unstated success claims.",
      successSummary || "No successful tool calls were confirmed.",
      "Tool errors:",
      errorSummary
    ];
    message = lines.filter(Boolean).join("\n");
  }

  return {
    message,
    thinking: flattened.thinking,
    toolCalls: allToolCalls.length > 0 ? allToolCalls : flattened.toolCalls,
    provider: typedProvider,
    model: resolvedModelId
  };
}
