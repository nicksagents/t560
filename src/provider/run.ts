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
import { getCredential, normalizeSetupService } from "../security/credentials-vault.js";
import { createT560CodingTools } from "../agents/pi-tools.js";
import { loadT560BootstrapContext } from "../agents/bootstrap-context.js";
import { executeToolCall, toToolDefinitions } from "../agents/pi-tool-definition-adapter.js";
import { normalizeToolParameters } from "../agents/pi-tools.schema.js";
import { resolveSkillsPromptForRun } from "../agents/skills.js";
import { buildAgentSystemPrompt } from "../agents/system-prompt.js";
import { emitAgentEvent } from "../agents/agent-events.js";
import { extractEcommerceCandidates, pickCheapestCandidate } from "../agents/ecommerce.js";
import {
  beginCheckoutWorkflowTurn,
  describeCheckoutWorkflowState,
  enforceCheckoutWorkflow,
} from "../agents/checkout-workflow.js";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
  handleToolExecutionUpdate,
} from "../agents/tool-execution-events.js";

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
const MAX_TOOL_ROUNDS = 20;
const TOOL_ERROR_PREVIEW_MAX_CHARS = 240;
const EMPTY_REPLY_URL_SCAN_LIMIT = 20;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
const MIN_PROVIDER_TIMEOUT_MS = 5_000;
const MAX_PROVIDER_TIMEOUT_MS = 15 * 60_000;
const MFA_PENDING_SESSION_MAX = 1024;

type PendingMfaSession = {
  service?: string;
  tabId?: string;
  since: number;
};

const pendingMfaBySession = new Map<string, PendingMfaSession>();

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
  const modelDef = params.modelDef as unknown as {
    api?: unknown;
    compat?: Record<string, unknown>;
    headers?: Record<string, string>;
    [key: string]: unknown;
  };
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
    ...(params.modelDef as unknown as Record<string, unknown>),
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
    ...(template as unknown as Record<string, unknown>),
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

function normalizeUrlCandidate(value: string): string | null {
  const trimmed = value.trim().replace(/[)\],.;]+$/g, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function collectUrlsFromUnknown(
  value: unknown,
  out: string[],
  seen: Set<string>,
  budget: { remaining: number },
): void {
  if (budget.remaining <= 0 || value === null || value === undefined) {
    return;
  }
  budget.remaining -= 1;

  if (typeof value === "string") {
    const matches = value.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
    for (const raw of matches) {
      const url = normalizeUrlCandidate(raw);
      if (!url || seen.has(url)) {
        continue;
      }
      seen.add(url);
      out.push(url);
      if (out.length >= EMPTY_REPLY_URL_SCAN_LIMIT) {
        return;
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 80)) {
      collectUrlsFromUnknown(entry, out, seen, budget);
      if (out.length >= EMPTY_REPLY_URL_SCAN_LIMIT) {
        return;
      }
    }
    return;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const [key, entry] of Object.entries(record).slice(0, 80)) {
      if (key === "text") {
        continue;
      }
      collectUrlsFromUnknown(entry, out, seen, budget);
      if (out.length >= EMPTY_REPLY_URL_SCAN_LIMIT) {
        return;
      }
    }
  }
}

function collectOutcomeUrls(outcomes: Array<{ content: string }>): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    const raw = String(outcome.content ?? "");
    try {
      collectUrlsFromUnknown(JSON.parse(raw), urls, seen, { remaining: 500 });
    } catch {
      collectUrlsFromUnknown(raw, urls, seen, { remaining: 80 });
    }
    if (urls.length >= EMPTY_REPLY_URL_SCAN_LIMIT) {
      break;
    }
  }
  return urls;
}

function pickBestVerifiedUrl(urls: string[]): string | null {
  if (urls.length === 0) {
    return null;
  }
  const score = (url: string): number => {
    if (/\/dp\/|\/gp\/product\//i.test(url)) {
      return 100;
    }
    if (/amazon\./i.test(url) && (/[?&]k=/i.test(url) || /\/s\?/i.test(url))) {
      return 85;
    }
    if (/amazon\./i.test(url) && /\/[^/?#]+/.test(url.replace(/^https?:\/\/[^/]+/i, ""))) {
      return 70;
    }
    if (/amazon\./i.test(url)) {
      return 50;
    }
    return 20;
  };
  const sorted = [...urls].sort((a, b) => score(b) - score(a));
  return sorted[0] ?? null;
}

function buildToolOnlyFallbackMessage(params: {
  userMessage: string;
  successfulToolOutcomes: Array<{ toolName: string; content: string }>;
  failedToolOutcomes: Array<{ toolName: string }>;
}): string {
  const urls = collectOutcomeUrls(params.successfulToolOutcomes);
  const bestUrl = pickBestVerifiedUrl(urls);
  const commerceCandidates = extractEcommerceCandidates({
    query: params.userMessage,
    outcomes: params.successfulToolOutcomes,
    limit: 6,
  });
  const cheapest = pickCheapestCandidate(commerceCandidates);
  const successfulNames = Array.from(new Set(params.successfulToolOutcomes.map((entry) => entry.toolName)));
  const cheapestLine =
    cheapest && cheapest.price
      ? `Cheapest product candidate: ${cheapest.title || "item"} at ${cheapest.price.display} (${cheapest.url})`
      : null;
  const linkLine =
    cheapest && cheapest.url
      ? bestUrl && bestUrl !== cheapest.url
        ? `Additional verified link: ${bestUrl}`
        : null
      : bestUrl
        ? `I found a verified link from browser results: ${bestUrl}`
        : "I completed browser actions but could not extract a stable product link yet.";
  const lines = [
    cheapestLine,
    linkLine,
    successfulNames.length > 0 ? `Successful tools: ${successfulNames.join(", ")}` : null,
  ];
  if (params.failedToolOutcomes.length > 0) {
    lines.push(`Failed tools: ${params.failedToolOutcomes.map((entry) => entry.toolName).join(", ")}`);
  }
  lines.push("Tell me to continue and I will keep browsing from the current tab state.");
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function hasTool(tools: Array<{ name: string }>, wanted: string): boolean {
  const key = wanted.trim().toLowerCase();
  return tools.some((tool) => String(tool.name ?? "").trim().toLowerCase() === key);
}

function shouldAttemptWebRecovery(params: {
  tools: Array<{ name: string }>;
  userMessage: string;
  toolOutcomes: Array<{ toolName: string; isError: boolean }>;
}): boolean {
  const hasWebSearch = hasTool(params.tools, "web_search");
  const hasWebFetch = hasTool(params.tools, "web_fetch");
  if (!hasWebSearch && !hasWebFetch) {
    return false;
  }
  const likelyLookup = /\b(search|look up|lookup|latest|current|today|news|web|internet|url|website|source|login|log in|sign in|otp|one[-\s]?time code|verification code|2fa|mfa|auth)\b/i.test(
    params.userMessage,
  );
  if (!likelyLookup) {
    return false;
  }

  const browserFailed = params.toolOutcomes.some(
    (entry) => entry.isError && String(entry.toolName ?? "").trim().toLowerCase() === "browser",
  );
  if (!browserFailed) {
    return false;
  }

  const webSearchSucceeded =
    hasWebSearch &&
    params.toolOutcomes.some(
      (entry) => !entry.isError && String(entry.toolName ?? "").trim().toLowerCase() === "web_search",
    );
  const webFetchSucceeded =
    hasWebFetch &&
    params.toolOutcomes.some(
      (entry) => !entry.isError && String(entry.toolName ?? "").trim().toLowerCase() === "web_fetch",
    );
  return !webSearchSucceeded && !webFetchSucceeded;
}

function buildWebRecoveryInstruction(tools: Array<{ name: string }>): string {
  const hasWebSearch = hasTool(tools, "web_search");
  const hasWebFetch = hasTool(tools, "web_fetch");
  if (hasWebSearch) {
    return "System recovery instruction: Browser interaction failed. For this factual lookup, retry using web_search (and web_fetch as needed), then answer from successful tool outputs only.";
  }
  if (hasWebFetch) {
    return "System recovery instruction: Browser interaction failed. For this factual lookup, use browser action=search/open to locate a relevant URL, then ground the answer with web_fetch output only.";
  }
  return "System recovery instruction: Browser interaction failed. Retry with a simpler browser path and answer only from successful tool outputs.";
}

function hasLikelyLogoutIntent(message: string): boolean {
  const text = String(message ?? "").toLowerCase();
  if (!text.trim()) {
    return false;
  }
  if (
    /\blogout\b/.test(text) ||
    /\blog\s*out\b/.test(text) ||
    /\blog\s*iut\b/.test(text) ||
    /\blog\s*uot\b/.test(text) ||
    /\blog\s*ot\b/.test(text) ||
    /\bsign\s*out\b/.test(text) ||
    /\bsignout\b/.test(text) ||
    /\bsign\s*off\b/.test(text)
  ) {
    return true;
  }
  return false;
}

function buildLogoutToolForceInstruction(): string {
  return [
    "System instruction: this is a logout request for the current website session.",
    "Use browser tools now.",
    "Steps: 1) capture snapshot of the current tab, 2) locate sign out/log out/logout control, 3) click it, 4) verify logged-out state in the resulting page.",
    "Then provide a concise completion message with verified outcome.",
  ].join(" ");
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
    ||
    /\b(login|log in|logout|log out|sign in|sign out|signout|otp|one[-\s]?time code|verification code|2fa|mfa|authenticator|passcode)\b/.test(
      text,
    ) ||
    hasLikelyLogoutIntent(text) ||
    /\benter (that )?code\b/.test(text)
  );
}

function extractLikelyOneTimeCode(message: string): string | null {
  const compact = String(message ?? "").trim().replace(/\s+/g, "");
  if (!compact) {
    return null;
  }
  if (/^\d{4,10}$/.test(compact)) {
    return compact;
  }
  if (/^[A-Za-z0-9]{6,10}$/.test(compact) && /\d/.test(compact)) {
    return compact;
  }
  return null;
}

function parseJsonRecord(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(content ?? ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

function getNestedRecord(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = source[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function updatePendingMfaStateFromBrowserTool(params: {
  sessionId: string;
  toolArgs: unknown;
  outcomeContent: string;
  isError: boolean;
}): void {
  const toolArgs = params.toolArgs && typeof params.toolArgs === "object"
    ? (params.toolArgs as Record<string, unknown>)
    : {};
  const action = String(toolArgs.action ?? "").trim().toLowerCase();
  if (action === "mfa" && !params.isError) {
    pendingMfaBySession.delete(params.sessionId);
    return;
  }
  if (params.isError) {
    return;
  }

  const parsed = parseJsonRecord(params.outcomeContent);
  if (!parsed) {
    return;
  }

  const mfaRecord = getNestedRecord(parsed, "mfa");
  const requiresMfa =
    parsed.requiresMfa === true ||
    mfaRecord?.required === true ||
    mfaRecord?.requiresMfa === true;
  const mfaSubmitted =
    parsed.mfaSubmitted === true ||
    mfaRecord?.submitted === true ||
    mfaRecord?.handled === true;

  if (mfaSubmitted) {
    pendingMfaBySession.delete(params.sessionId);
    return;
  }
  if (!requiresMfa) {
    if (action === "login") {
      pendingMfaBySession.delete(params.sessionId);
    }
    return;
  }

  const tabRecord = getNestedRecord(parsed, "tab");
  const activeTabId = String(parsed.activeTabId ?? tabRecord?.id ?? "").trim();
  const service = String(parsed.service ?? "").trim();
  pendingMfaBySession.set(params.sessionId, {
    ...(service ? { service } : {}),
    ...(activeTabId ? { tabId: activeTabId } : {}),
    since: Date.now(),
  });
  if (pendingMfaBySession.size > MFA_PENDING_SESSION_MAX) {
    const oldest = pendingMfaBySession.keys().next().value;
    if (oldest) {
      pendingMfaBySession.delete(oldest);
    }
  }
}

function buildMfaContinuationInstruction(params: {
  userMessage: string;
  mfaCode: string;
  pending: PendingMfaSession;
}): string {
  const actionLine = [
    "System instruction: An earlier browser login is waiting for an MFA code.",
    `Use browser tool immediately with action="mfa", code="${params.mfaCode}"`,
    `${params.pending.tabId ? `, tabId="${params.pending.tabId}"` : ""}.`,
    `${params.pending.service ? `Use service="${params.pending.service}" if needed.` : ""}`,
    "Do not ask the user to repeat this same code.",
  ]
    .join(" ")
    .trim();
  return `${actionLine}\nOriginal user message: ${params.userMessage}`;
}

function looksLikeLoginIntent(message: string): boolean {
  const text = String(message ?? "").toLowerCase();
  return /\b(login|log in|sign in|authenticate|verification|one[-\s]?time code|otp|2fa|mfa)\b/.test(text);
}

function assistantIsAskingForIdentifier(text: string): boolean {
  const normalized = String(text ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    /\b(which|what)\s+(email|username)\b/.test(normalized) ||
    /\bemail should i use\b/.test(normalized) ||
    /\busername should i use\b/.test(normalized) ||
    /\bwhat (is )?your email\b/.test(normalized) ||
    /\bprovide (your )?(email|username)\b/.test(normalized)
  );
}

function extractHostFromBrowserOutcomeContent(content: string): string | null {
  const parsed = parseJsonRecord(content);
  if (!parsed) {
    return null;
  }
  const candidates = [
    String(parsed.url ?? ""),
    String(getNestedRecord(parsed, "snapshot")?.url ?? ""),
    String(getNestedRecord(parsed, "tab")?.url ?? ""),
    String(getNestedRecord(parsed, "openedSnapshot")?.url ?? ""),
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  for (const raw of candidates) {
    try {
      const host = new URL(raw).hostname.trim().toLowerCase();
      if (host) {
        return host.startsWith("www.") ? host.slice(4) : host;
      }
    } catch {
      // ignore invalid URL fragments
    }
  }
  return null;
}

function buildServiceCandidatesFromHost(host: string): string[] {
  const normalizedHost = String(host ?? "").trim().toLowerCase().replace(/^www\./, "");
  if (!normalizedHost) {
    return [];
  }
  const candidates = new Set<string>();
  const push = (value: string) => {
    const normalized = normalizeSetupService(value);
    if (normalized) {
      candidates.add(normalized);
    }
  };
  push(normalizedHost);
  const firstLabel = normalizedHost.split(".")[0] ?? "";
  if (firstLabel) {
    push(firstLabel);
  }
  return Array.from(candidates);
}

async function resolveSavedServiceFromBrowserOutcomes(params: {
  workspaceDir: string;
  toolOutcomes: Array<{ toolName: string; isError: boolean; content: string }>;
}): Promise<string | null> {
  const successfulBrowserOutcomes = params.toolOutcomes
    .filter((entry) => !entry.isError && String(entry.toolName ?? "").trim().toLowerCase() === "browser")
    .slice()
    .reverse();
  for (const outcome of successfulBrowserOutcomes) {
    const host = extractHostFromBrowserOutcomeContent(outcome.content);
    if (!host) {
      continue;
    }
    const serviceCandidates = buildServiceCandidatesFromHost(host);
    for (const service of serviceCandidates) {
      const credential = await getCredential({
        workspaceDir: params.workspaceDir,
        service,
      });
      if (credential) {
        return service;
      }
    }
  }
  return null;
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
  const pendingMfa = pendingMfaBySession.get(sessionId);
  const oneTimeCode = extractLikelyOneTimeCode(params.message);
  const effectiveUserMessage =
    pendingMfa && oneTimeCode
      ? buildMfaContinuationInstruction({
          userMessage: params.message,
          mfaCode: oneTimeCode,
          pending: pendingMfa,
        })
      : params.message;
  const userMessage: Message = {
    role: "user",
    content: effectiveUserMessage,
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
  let recoveryPromptSent = false;
  let finalizationPromptSent = false;
  let emptyReplyRecoveryPromptSent = false;
  let lastAssistant: AssistantMessage | undefined;
  let checkoutBlockedMessage: string | null = null;
  const forceToolUse =
    !smallTalkTurn &&
    (requestLikelyNeedsTools(params.message) || Boolean(pendingMfa && oneTimeCode));
  const providerTimeoutMs = resolveProviderTimeoutMs();
  const modelBaseUrl =
    typeof (modelDef as { baseUrl?: unknown }).baseUrl === "string"
      ? (modelDef as { baseUrl: string }).baseUrl
      : "";
  const requestAssistant = async (context: Context): Promise<AssistantMessage> => {
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
    }, providerTimeoutMs);
    timeout.unref?.();
    try {
      return await complete(modelDef, context, {
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
  };
  const emitAssistantProgress = (text: string, phase: "pretool" | "progress" = "progress") => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    emitAgentEvent({
      stream: "assistant",
      sessionId,
      channel: params.channel,
      timestamp: Date.now(),
      data: {
        phase,
        text: trimmed,
      },
    });
  };

  beginCheckoutWorkflowTurn({
    sessionId,
    userMessage: params.message,
  });
  emitAssistantProgress("Analyzing request and planning tool steps.", "pretool");

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (round > 0) {
      emitAssistantProgress(`Continuing with tool-assisted reasoning (round ${round + 1}/${MAX_TOOL_ROUNDS}).`);
    }
    const context: Context = {
      systemPrompt,
      tools: finalizationPromptSent ? [] : toolDefinitions,
      messages
    };
    const assistant = await requestAssistant(context);

    messages.push(assistant);
    lastAssistant = assistant;

    const toolCalls = assistant.content.filter(
      (block): block is Extract<AssistantMessage["content"][number], { type: "toolCall" }> =>
        block.type === "toolCall"
    );

    if (toolCalls.length === 0) {
      const roundFlattened = flattenAssistantMessage(assistant);
      if (
        looksLikeLoginIntent(params.message) &&
        assistantIsAskingForIdentifier(roundFlattened.text) &&
        allToolCalls.length > 0
      ) {
        const savedService = await resolveSavedServiceFromBrowserOutcomes({
          workspaceDir: process.cwd(),
          toolOutcomes,
        });
        if (savedService) {
          emitAssistantProgress("Saved credentials found for current login site; continuing without asking for email.");
          messages.push({
            role: "user",
            content: [
              "System instruction: secure credentials already exist for the current site.",
              `Do not ask the user for email or username.`,
              `Immediately call browser action=\"login\" with service=\"${savedService}\" on the current tab, then continue the login flow.`,
            ].join(" "),
            timestamp: Date.now()
          });
          continue;
        }
      }
      if (!roundFlattened.text && !emptyReplyRecoveryPromptSent) {
        emitAssistantProgress("Model returned an empty reply; requesting explicit completion.");
        emptyReplyRecoveryPromptSent = true;
        const emptyRecoveryInstruction =
          forceToolUse && hasLikelyLogoutIntent(params.message)
            ? buildLogoutToolForceInstruction()
            : forceToolUse
              ? "System instruction: your previous response was empty. Execute the required tools now, then provide a complete user-facing answer."
              : "System instruction: your previous response was empty. Provide a complete, non-empty user-facing answer now.";
        messages.push({
          role: "user",
          content: emptyRecoveryInstruction,
          timestamp: Date.now()
        });
        continue;
      }
      if (!roundFlattened.text && !finalizationPromptSent && allToolCalls.length > 0) {
        emitAssistantProgress("Tool execution finished; finalizing the user-facing answer.");
        finalizationPromptSent = true;
        messages.push({
          role: "user",
          content:
            "System instruction: provide the final user-facing answer now using only verified tool results already produced in this session. Do not call tools. Include the best direct URL when available.",
          timestamp: Date.now()
        });
        continue;
      }
      if (round === 0 && forceToolUse) {
        emitAssistantProgress("Request needs verified tool execution before answering.");
        const toolForceInstruction = hasLikelyLogoutIntent(params.message)
          ? buildLogoutToolForceInstruction()
          : "System instruction: this request requires real tool execution. Use tools now and only report verified outcomes from tool results.";
        messages.push({
          role: "user",
          content: toolForceInstruction,
          timestamp: Date.now()
        });
        continue;
      }
      if (
        !recoveryPromptSent &&
        shouldAttemptWebRecovery({
          tools,
          userMessage: params.message,
          toolOutcomes
        })
      ) {
        emitAssistantProgress("Primary browser path failed; switching to web recovery flow.");
        recoveryPromptSent = true;
        messages.push({
          role: "user",
          content: buildWebRecoveryInstruction(tools),
          timestamp: Date.now()
        });
        continue;
      }
      break;
    }

    for (const toolCall of toolCalls) {
      allToolCalls.push(toolCall.name);
      let outcome: { isError: boolean; content: string };
      const checkoutDecision = enforceCheckoutWorkflow({
        sessionId,
        toolName: toolCall.name,
        toolArgs: toolCall.arguments,
      });
      if (!checkoutDecision.allowed) {
        checkoutBlockedMessage = checkoutDecision.message;
        handleToolExecutionStart({
          sessionId,
          channel: params.channel,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: (toolCall.arguments && typeof toolCall.arguments === "object"
            ? (toolCall.arguments as Record<string, unknown>)
            : {}) as Record<string, unknown>,
        });
        handleToolExecutionEnd({
          sessionId,
          channel: params.channel,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          result: checkoutDecision.message,
          error: checkoutDecision.message,
        });
        outcome = {
          isError: true,
          content: checkoutDecision.message,
        };
      } else {
        outcome = await executeToolCall({
          tools,
          toolDefinitions,
          toolCall,
          context: {
            sessionId,
            channel: params.channel,
            provider: typedProvider,
            model: resolvedModelId
          },
          eventHooks: {
            onStart: ({ toolCallId, toolName, args }) => {
              handleToolExecutionStart({
                sessionId,
                channel: params.channel,
                toolCallId,
                toolName,
                args,
              });
            },
            onUpdate: ({ toolCallId, toolName, partialResult }) => {
              handleToolExecutionUpdate({
                sessionId,
                channel: params.channel,
                toolCallId,
                toolName,
                partialResult,
              });
            },
            onEnd: ({ toolCallId, toolName, result, isError, error }) => {
              handleToolExecutionEnd({
                sessionId,
                channel: params.channel,
                toolCallId,
                toolName,
                result,
                ...(isError ? { error: error ?? "tool execution failed" } : {}),
              });
            },
          },
        });
      }
      toolOutcomes.push({
        toolName: toolCall.name,
        isError: outcome.isError,
        content: outcome.content
      });
      if (String(toolCall.name ?? "").trim().toLowerCase() === "browser") {
        updatePendingMfaStateFromBrowserTool({
          sessionId,
          toolArgs: toolCall.arguments,
          outcomeContent: outcome.content,
          isError: outcome.isError,
        });
      }

      messages.push({
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: outcome.content }],
        isError: outcome.isError,
        timestamp: Date.now()
      });
      if (checkoutBlockedMessage) {
        break;
      }
    }
    if (checkoutBlockedMessage) {
      break;
    }
  }

  if (!lastAssistant) {
    throw new Error("Provider did not return an assistant response.");
  }

  if (allToolCalls.length > 0 && !flattenAssistantMessage(lastAssistant).text) {
    try {
      messages.push({
        role: "user",
        content:
          "System instruction: provide the final user-facing answer now using only verified tool results already produced in this session. Do not call tools. Include the best direct URL when available.",
        timestamp: Date.now()
      });
      const finalAssistant = await requestAssistant({
        systemPrompt,
        tools: [],
        messages,
      });
      messages.push(finalAssistant);
      lastAssistant = finalAssistant;
    } catch {
      // Fallback response synthesis below handles cases where post-tool finalization still fails.
    }
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
  let message = flattened.text || "";
  let usedToolOnlyFallback = false;
  if (!flattened.text && allToolCalls.length > 0) {
    usedToolOnlyFallback = true;
    message = buildToolOnlyFallbackMessage({
      userMessage: params.message,
      successfulToolOutcomes,
      failedToolOutcomes,
    });
  }

  if (forceToolUse && allToolCalls.length === 0) {
    message = [
      "I could not complete this action because no tools were executed.",
      "I will only claim completion after real tool execution confirms results."
    ].join("\n");
  }

  if (!message.trim()) {
    message = allToolCalls.length > 0
      ? [
          "I completed tool execution but did not receive a final textual summary from the model.",
          successSummary || null,
        ]
          .filter(Boolean)
          .join("\n")
      : "I could not generate a non-empty response for this request. Please retry and I will continue from the current session state.";
  }

  if (failedToolOutcomes.length > 0 && successfulToolOutcomes.length === 0) {
    const lines = [
      "I completed this request with tool failures, so you should not trust any unstated success claims.",
      successSummary || "No successful tool calls were confirmed.",
      "Tool errors:",
      errorSummary
    ];
    message = lines.filter(Boolean).join("\n");
  } else if (failedToolOutcomes.length > 0 && !usedToolOnlyFallback) {
    const warning = [
      "Note: some tool calls failed, but the response is based on successful tool outputs.",
      successSummary || "",
      `Failed tools: ${failedToolOutcomes.map((entry) => entry.toolName).join(", ")}`,
    ]
      .filter(Boolean)
      .join("\n");
    message = [message, warning].filter(Boolean).join("\n\n");
  }

  if (checkoutBlockedMessage) {
    const status = describeCheckoutWorkflowState(sessionId);
    message = [
      checkoutBlockedMessage,
      status ? `Workflow state: ${status}` : null,
      "If you want me to continue with checkout, send: confirm purchase",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return {
    message,
    thinking: flattened.thinking,
    toolCalls: allToolCalls.length > 0 ? allToolCalls : flattened.toolCalls,
    provider: typedProvider,
    model: resolvedModelId
  };
}
