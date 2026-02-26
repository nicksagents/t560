import { appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  complete,
  getModel,
  getModels,
  getProviders,
  type Api,
  type AssistantMessage,
  type Context,
  type KnownProvider,
  type Message,
  type ToolCall,
} from "@mariozechner/pi-ai";
import type { GatewayChannelId } from "../gateway/types.js";
import {
  resolveLegacyUserPath,
  resolveStateDir,
  resolveSoulPath,
  resolveUsersPath,
  type ProviderProfile,
  type RoutingTarget,
  type T560Config
} from "../config/state.js";
import { loadSessionMessages, saveSessionMessages } from "./session.js";
import { getCredential, listConfiguredServices, normalizeSetupService } from "../security/credentials-vault.js";
import { createT560CodingTools } from "../agents/pi-tools.js";
import type { InjectedContextFile } from "../agents/bootstrap-context.js";
import { executeToolCall, toToolDefinitions } from "../agents/pi-tool-definition-adapter.js";
import { normalizeToolParameters } from "../agents/pi-tools.schema.js";
import { resolveSkillsPromptForRun, resolveToolSkillRemindersForRun } from "../agents/skills.js";
import { buildAgentSystemPrompt } from "../agents/system-prompt.js";
import { createMemorySaveTool } from "../agents/tools/memory-tools.js";
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
const OPENAI_RUNTIME_PROVIDER = "openai";
const LOCAL_OPENAI_DUMMY_API_KEY = "local-no-key";
const PROVIDER_RUNTIME_ALIASES: Record<string, KnownProvider> = {
  "deepseek": "openai",
  "local-openai": "openai",
};
const DEEPSEEK_MODEL_ALIAS_MAP: Record<string, string> = {
  "deepseek-chat": "deepseek-chat",
  "deepseek-v3": "deepseek-chat",
  "deepseek-v3-0324": "deepseek-chat",
  "deepseek-v3.1": "deepseek-chat",
  "deepseek-v3.1-terminus": "deepseek-chat",
  "deepseek-v3.2": "deepseek-chat",
  "deepseek-v3.2-exp": "deepseek-chat",
  "deepseek-reasoner": "deepseek-reasoner",
  "deepseek-r1": "deepseek-reasoner",
  "deepseek-r1-0528": "deepseek-reasoner",
};
const MAX_TOOL_ROUNDS = 20;
const COMPACT_MODE_MAX_TOOL_ROUNDS = 8;
const TOOL_ERROR_PREVIEW_MAX_CHARS = 240;
const EMPTY_REPLY_URL_SCAN_LIMIT = 20;
const DEFAULT_TOOL_RESULT_CONTEXT_MAX_CHARS = 12_000;
const DEFAULT_COMPACT_TOOL_RESULT_CONTEXT_MAX_CHARS = 2_500;
const DEFAULT_COMPACT_HISTORY_MESSAGES = 10;
const MIN_COMPACT_HISTORY_MESSAGES = 2;
const MAX_COMPACT_HISTORY_MESSAGES = 20;
const DEFAULT_PROVIDER_TIMEOUT_MS = 10 * 60_000;
const MIN_PROVIDER_TIMEOUT_MS = 5_000;
const MAX_PROVIDER_TIMEOUT_MS = 24 * 60 * 60_000;
const DEFAULT_LOCAL_PROVIDER_TIMEOUT_MS = 30 * 60_000;
const MIN_LOCAL_PROVIDER_TIMEOUT_MS = 60_000;
const DEFAULT_TOOL_TIMEOUT_MS = 180_000;
const MIN_TOOL_TIMEOUT_MS = 5_000;
const MAX_TOOL_TIMEOUT_MS = 30 * 60_000;
const MFA_PENDING_SESSION_MAX = 1024;
const LIVE_PROGRESS_LINE_MAX = 420;
const LIVE_PROGRESS_LINES_PER_ROUND = 8;
const AUTO_MEMORY_MAX_CANDIDATES = 2;
const LOCAL_MODEL_DISCOVERY_TIMEOUT_MS = 4_000;
const LOCAL_MODEL_DISCOVERY_TTL_MS = 30_000;
const PROMPT_TRACE_DEFAULT_FILENAME = "prompt-trace.jsonl";
const GENERIC_PROGRESS_PATTERNS: RegExp[] = [
  /^i am using the latest findings(?: to choose the next step)?\.?$/i,
  /^using the latest findings(?: to choose the next step)?\.?$/i,
  /^i am (?:continuing|proceeding|working) (?:on|with) (?:the )?(?:task|request|analysis)\.?$/i,
  /^i will continue from here\.?$/i,
  /^working on it\.?$/i,
  /^analyzing(?: request)?(?: and planning)?(?: tool steps)?\.?$/i,
];

function isPromptTraceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.T560_DEBUG_PROMPT_TRACE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function resolvePathFromEnv(raw: string): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    return value;
  }
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function resolvePromptTracePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.T560_DEBUG_PROMPT_TRACE_PATH ?? "").trim();
  if (explicit) {
    return resolvePathFromEnv(explicit);
  }
  return path.join(resolveStateDir(env), PROMPT_TRACE_DEFAULT_FILENAME);
}

function stringifyPromptTraceRecord(record: unknown): string {
  return JSON.stringify(
    record,
    (_key, value) => {
      if (typeof value === "bigint") {
        return value.toString();
      }
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }
      return value;
    },
  );
}

async function appendPromptTraceRecord(record: unknown, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!isPromptTraceEnabled(env)) {
    return;
  }
  try {
    const tracePath = resolvePromptTracePath(env);
    await mkdir(path.dirname(tracePath), { recursive: true });
    await appendFile(tracePath, `${stringifyPromptTraceRecord(record)}\n`, "utf-8");
  } catch {
    // Debug logging must never fail the user request path.
  }
}

type PendingMfaSession = {
  service?: string;
  mfaSourceService?: string;
  tabId?: string;
  since: number;
};

const pendingMfaBySession = new Map<string, PendingMfaSession>();
const localOpenAIModelDiscoveryCache = new Map<string, { expiresAt: number; models: string[] }>();

type AutoMemoryCandidate = {
  title: string;
  content: string;
  tags: string[];
};

function isAutoMemoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.T560_MEMORY_AUTO_SAVE ?? "").trim().toLowerCase();
  if (!raw) {
    return true;
  }
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") {
    return false;
  }
  return true;
}

function clipAutoMemoryText(value: string, maxChars: number): string {
  const compact = String(value ?? "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, maxChars - 3).trim()}...`;
}

function extractAutoMemoryCandidates(message: string): AutoMemoryCandidate[] {
  const source = String(message ?? "").trim();
  if (!source || source.length > 600) {
    return [];
  }
  if (/\b(?:don't|do not)\s+remember\b/i.test(source)) {
    return [];
  }

  const candidates: AutoMemoryCandidate[] = [];
  const seen = new Set<string>();
  const addCandidate = (candidate: AutoMemoryCandidate) => {
    const title = clipAutoMemoryText(candidate.title, 80);
    const content = clipAutoMemoryText(candidate.content, 420);
    const tags = Array.from(
      new Set(
        candidate.tags
          .map((tag) => String(tag ?? "").trim().toLowerCase())
          .filter(Boolean),
      ),
    ).slice(0, 8);
    if (!title || !content) {
      return;
    }
    const key = `${title}\n${content}`.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push({ title, content, tags });
  };

  const explicitRemember = /\b(?:remember|for future reference|note that)\b[:,-]?\s*(.+)$/i.exec(source);
  if (explicitRemember?.[1]) {
    addCandidate({
      title: "User explicit memory",
      content: explicitRemember[1],
      tags: ["user", "explicit", "memory"],
    });
  }

  const preference = /\b(?:i|we)\s+(?:prefer|like)\s+(.{3,220})$/i.exec(source);
  if (preference?.[1]) {
    addCandidate({
      title: "User preference",
      content: `User preference: ${preference[1]}`,
      tags: ["user", "preference"],
    });
  }

  const name = /\b(?:my name is|call me)\s+([A-Za-z][A-Za-z0-9 _-]{1,40})\b/i.exec(source);
  if (name?.[1]) {
    addCandidate({
      title: "User identity",
      content: `Preferred name: ${name[1].trim()}`,
      tags: ["user", "identity"],
    });
  }

  const timezone = /\bmy timezone is\s+([A-Za-z0-9_+/:-]{2,64})\b/i.exec(source);
  if (timezone?.[1]) {
    addCandidate({
      title: "User timezone",
      content: `Timezone: ${timezone[1].trim()}`,
      tags: ["user", "timezone"],
    });
  }

  const workflow = /\b(?:always|default to)\s+(.{4,220})$/i.exec(source);
  if (workflow?.[1]) {
    addCandidate({
      title: "User workflow preference",
      content: `Workflow preference: ${workflow[1]}`,
      tags: ["user", "workflow", "preference"],
    });
  }

  return candidates.slice(0, AUTO_MEMORY_MAX_CANDIDATES);
}

async function maybeAutoSaveMemoryFromUserMessage(params: {
  message: string;
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
  skip: boolean;
}): Promise<void> {
  if (params.skip) {
    return;
  }
  const env = params.env ?? process.env;
  if (!isAutoMemoryEnabled(env)) {
    return;
  }
  const candidates = extractAutoMemoryCandidates(params.message);
  if (candidates.length === 0) {
    return;
  }
  const tool = createMemorySaveTool({
    workspaceDir: params.workspaceDir,
    env,
  });
  for (let idx = 0; idx < candidates.length; idx += 1) {
    const candidate = candidates[idx];
    try {
      await tool.execute(`auto-memory-${Date.now()}-${idx}`, candidate);
    } catch {
      // Best effort: do not fail the user response if autosave is blocked or invalid.
    }
  }
}

function hostLooksLocal(hostname: string): boolean {
  const host = String(hostname ?? "").trim().toLowerCase();
  if (!host) {
    return false;
  }
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) {
    return true;
  }
  if (host.startsWith("127.")) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) {
    return false;
  }
  const a = Number(ipv4[1]);
  const b = Number(ipv4[2]);
  if (a === 10) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  return false;
}

function isLikelyLocalProviderEndpoint(params: {
  routeProviderId?: string;
  baseUrl?: string;
}): boolean {
  const providerId = String(params.routeProviderId ?? "").trim().toLowerCase();
  if (providerId === "local-openai" || providerId.includes("local")) {
    return true;
  }
  const rawBaseUrl = String(params.baseUrl ?? "").trim();
  if (!rawBaseUrl) {
    return false;
  }
  try {
    const hostname = new URL(rawBaseUrl).hostname;
    return hostLooksLocal(hostname);
  } catch {
    return false;
  }
}

function resolveProviderTimeoutMs(params?: {
  routeProviderId?: string;
  baseUrl?: string;
}): number {
  const rawSec = Number(process.env.T560_PROVIDER_TIMEOUT_SEC ?? "");
  if (Number.isFinite(rawSec) && rawSec > 0) {
    return Math.min(MAX_PROVIDER_TIMEOUT_MS, Math.max(MIN_PROVIDER_TIMEOUT_MS, Math.floor(rawSec * 1000)));
  }
  const rawMs = Number(process.env.T560_PROVIDER_TIMEOUT_MS ?? "");
  if (Number.isFinite(rawMs) && rawMs > 0) {
    return Math.min(MAX_PROVIDER_TIMEOUT_MS, Math.max(MIN_PROVIDER_TIMEOUT_MS, Math.floor(rawMs)));
  }
  const localRoute = isLikelyLocalProviderEndpoint({
    routeProviderId: params?.routeProviderId,
    baseUrl: params?.baseUrl,
  });
  if (localRoute) {
    const localSec = Number(process.env.T560_PROVIDER_TIMEOUT_LOCAL_SEC ?? "");
    if (Number.isFinite(localSec) && localSec > 0) {
      return Math.min(
        MAX_PROVIDER_TIMEOUT_MS,
        Math.max(MIN_LOCAL_PROVIDER_TIMEOUT_MS, Math.floor(localSec * 1000)),
      );
    }
    const localMs = Number(process.env.T560_PROVIDER_TIMEOUT_LOCAL_MS ?? "");
    if (Number.isFinite(localMs) && localMs > 0) {
      return Math.min(
        MAX_PROVIDER_TIMEOUT_MS,
        Math.max(MIN_LOCAL_PROVIDER_TIMEOUT_MS, Math.floor(localMs)),
      );
    }
    return DEFAULT_LOCAL_PROVIDER_TIMEOUT_MS;
  }
  return DEFAULT_PROVIDER_TIMEOUT_MS;
}

function resolveToolExecutionTimeoutMs(): number {
  const rawSec = Number(process.env.T560_TOOL_TIMEOUT_SEC ?? "");
  if (Number.isFinite(rawSec) && rawSec > 0) {
    return Math.min(MAX_TOOL_TIMEOUT_MS, Math.max(MIN_TOOL_TIMEOUT_MS, Math.floor(rawSec * 1000)));
  }
  const rawMs = Number(process.env.T560_TOOL_TIMEOUT_MS ?? "");
  if (Number.isFinite(rawMs) && rawMs > 0) {
    return Math.min(MAX_TOOL_TIMEOUT_MS, Math.max(MIN_TOOL_TIMEOUT_MS, Math.floor(rawMs)));
  }
  return DEFAULT_TOOL_TIMEOUT_MS;
}

function parseExplicitBoolean(value: string): boolean | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return null;
}

function isCompactModeEnabled(params: {
  routeProviderId: string;
  baseUrl?: string;
}): boolean {
  const explicit = parseExplicitBoolean(String(process.env.T560_SMALL_MODEL_MODE ?? ""));
  if (explicit !== null) {
    return explicit;
  }
  return isLikelyLocalProviderEndpoint({
    routeProviderId: params.routeProviderId,
    baseUrl: params.baseUrl,
  });
}

function resolveCompactHistoryMessages(): number {
  const raw = Number(process.env.T560_SMALL_MODEL_HISTORY_MESSAGES ?? "");
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(MAX_COMPACT_HISTORY_MESSAGES, Math.max(MIN_COMPACT_HISTORY_MESSAGES, Math.floor(raw)));
  }
  return DEFAULT_COMPACT_HISTORY_MESSAGES;
}

function resolveToolResultContextMaxChars(compactMode: boolean): number {
  const raw = Number(process.env.T560_TOOL_RESULT_CONTEXT_MAX_CHARS ?? "");
  if (Number.isFinite(raw) && raw > 200) {
    return Math.floor(raw);
  }
  const rawCompact = Number(process.env.T560_TOOL_RESULT_CONTEXT_COMPACT_MAX_CHARS ?? "");
  if (compactMode && Number.isFinite(rawCompact) && rawCompact > 200) {
    return Math.floor(rawCompact);
  }
  return compactMode
    ? DEFAULT_COMPACT_TOOL_RESULT_CONTEXT_MAX_CHARS
    : DEFAULT_TOOL_RESULT_CONTEXT_MAX_CHARS;
}

function clampTextForModelContext(text: string, maxChars: number): string {
  const source = String(text ?? "");
  if (source.length <= maxChars) {
    return source;
  }
  return `${source.slice(0, Math.max(0, maxChars - 42))}\n\n[truncated for model context]`;
}

function hasInjectedIdentityContent(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.trim() !== "(missing file)";
}

function buildInjectedIdentityContextFiles(params: {
  soulPath: string;
  soulContent: string;
  userPath: string;
  userContent: string;
}): InjectedContextFile[] {
  return [
    {
      name: "SOUL.md",
      path: params.soulPath,
      content: params.soulContent,
      missing: false,
      truncated: false,
      source: "fallback:soul",
      rawChars: params.soulContent.length,
      injectedChars: params.soulContent.length,
    },
    {
      name: "USER.md",
      path: params.userPath,
      content: params.userContent,
      missing: false,
      truncated: false,
      source: "fallback:user",
      rawChars: params.userContent.length,
      injectedChars: params.userContent.length,
    },
  ];
}

export function assertIdentityContextFilesInjected(
  files: Array<{ name: string; missing: boolean; content: string }>,
): void {
  const soul = files.find((entry) => String(entry.name).trim().toUpperCase() === "SOUL.MD");
  const user = files.find((entry) => String(entry.name).trim().toUpperCase() === "USER.MD");
  if (!soul || soul.missing || !hasInjectedIdentityContent(soul.content)) {
    throw new Error("SOUL.md must be injected into provider context for every run.");
  }
  if (!user || user.missing || !hasInjectedIdentityContent(user.content)) {
    throw new Error("USER.md must be injected into provider context for every run.");
  }
}

export function assertSystemPromptHasIdentityFiles(systemPrompt: string): void {
  const prompt = String(systemPrompt ?? "");
  if (!/<assistant_soul>/i.test(prompt)) {
    throw new Error("Provider system prompt missing injected assistant soul block.");
  }
  if (!/<user_profile>/i.test(prompt)) {
    throw new Error("Provider system prompt missing injected user profile block.");
  }
}

function firstNonEmptyLine(value: string): string {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
}

export function assertSystemPromptHasIdentityContent(params: {
  systemPrompt: string;
  soulContent: string;
  userContent: string;
}): void {
  const prompt = String(params.systemPrompt ?? "");
  const soulLine = firstNonEmptyLine(params.soulContent);
  const userLine = firstNonEmptyLine(params.userContent);
  if (!soulLine || !prompt.includes(soulLine)) {
    throw new Error("Provider system prompt missing SOUL.md content.");
  }
  if (!userLine || !prompt.includes(userLine)) {
    throw new Error("Provider system prompt missing USER.md content.");
  }
}

export function assertToolSkillCoverage(toolNames: string[], reminders: Record<string, string>): void {
  const normalized = Array.from(
    new Set(
      (toolNames ?? [])
        .map((name) => String(name ?? "").trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const uncovered = normalized.filter((name) => !String(reminders?.[name] ?? "").trim());
  if (uncovered.length > 0) {
    throw new Error(`Missing tool skill reminders for enabled tools: ${uncovered.join(", ")}`);
  }
}

function selectToolsForCompactMode<T extends { name: string }>(
  tools: T[],
  message: string,
  pendingMfa: boolean,
): T[] {
  const needsEmail = messageLikelyNeedsEmailTool(message) || pendingMfa;
  const needsWeb =
    looksLikeLoginIntent(message) ||
    looksLikeSiteVisitIntent(message) ||
    looksLikeAccountDashboardIntent(message) ||
    /\b(search|look up|lookup|latest|current|today|news|web|internet|url|website|source|open|visit|navigate)\b/i.test(
      message,
    ) ||
    pendingMfa;
  const needsMemory =
    /\b(memory|remember|recall|forget|preference|store this|save this|past conversation)\b/i.test(message);
  return tools.filter((tool) => {
    const normalized = String(tool.name ?? "").trim().toLowerCase();
    if (!needsMemory && normalized.startsWith("memory_")) {
      return false;
    }
    if (!needsWeb && (normalized === "browser" || normalized === "web_search" || normalized === "web_fetch")) {
      return false;
    }
    if (!needsEmail && normalized === "email") {
      return false;
    }
    return true;
  });
}

async function runWithHardTimeout<T>(params: {
  operation: Promise<T>;
  timeoutMs: number;
  timeoutMessage: string;
  onTimeout?: () => void;
}): Promise<T> {
  const operationOutcome = params.operation.then(
    (value) => ({ kind: "value" as const, value }),
    (error) => ({ kind: "error" as const, error }),
  );
  const timeoutOutcome = new Promise<{ kind: "timeout" }>((resolve) => {
    const timer = setTimeout(() => {
      try {
        params.onTimeout?.();
      } catch {
        // best effort
      }
      resolve({ kind: "timeout" });
    }, params.timeoutMs);
    timer.unref?.();
  });

  const winner = await Promise.race([operationOutcome, timeoutOutcome]);
  if (winner.kind === "value") {
    return winner.value;
  }
  if (winner.kind === "error") {
    throw winner.error;
  }
  throw new Error(params.timeoutMessage);
}

function defaultBaseUrlForProviderAlias(providerId: string): string | undefined {
  const normalized = String(providerId ?? "").trim().toLowerCase();
  if (normalized === "deepseek") {
    return "https://api.deepseek.com/v1";
  }
  if (normalized === "local-openai") {
    return "http://127.0.0.1:8080/v1";
  }
  return undefined;
}

function resolveRuntimeProvider(params: {
  routeProviderId: string;
  profile: ProviderProfile;
}): {
  requestedProvider: string;
  runtimeProvider: KnownProvider;
  baseUrlOverride?: string;
} {
  const routeProviderId = String(params.routeProviderId ?? "").trim().toLowerCase();
  const profileProvider = String(params.profile.provider ?? "").trim().toLowerCase();
  const requestedProvider = profileProvider || routeProviderId;

  if (!requestedProvider) {
    throw new Error(`Provider route '${params.routeProviderId}' does not specify a runtime provider.`);
  }

  if (SUPPORTED_PROVIDERS.has(requestedProvider)) {
    return {
      requestedProvider,
      runtimeProvider: requestedProvider as KnownProvider,
    };
  }

  const alias = PROVIDER_RUNTIME_ALIASES[requestedProvider];
  if (alias && SUPPORTED_PROVIDERS.has(alias)) {
    return {
      requestedProvider,
      runtimeProvider: alias,
      baseUrlOverride: defaultBaseUrlForProviderAlias(requestedProvider),
    };
  }

  const hasCustomBaseUrl = Boolean(normalizeBaseUrl(params.profile.baseUrl));
  if (hasCustomBaseUrl && SUPPORTED_PROVIDERS.has(OPENAI_RUNTIME_PROVIDER)) {
    return {
      requestedProvider,
      runtimeProvider: OPENAI_RUNTIME_PROVIDER as KnownProvider,
    };
  }

  throw new Error(`Provider '${requestedProvider}' is not supported by the provider runtime.`);
}

async function loadTextFile(path: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, "utf-8");
    return raw.trim() ? raw : undefined;
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

function stripInlineThinking(raw: string): { text: string; thinking: string | null } {
  const thinkParts: string[] = [];
  const stripped = raw.replace(/<think>([\s\S]*?)<\/think>/gi, (_, inner: string) => {
    thinkParts.push(inner.trim());
    return "";
  });
  return {
    text: stripped.trim(),
    thinking: thinkParts.length > 0 ? thinkParts.join("\n").trim() : null,
  };
}

function flattenAssistantMessage(message: AssistantMessage): FlattenedMessage {
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: string[] = [];

  for (const block of message.content) {
    if (block.type === "text") {
      const { text, thinking } = stripInlineThinking(block.text);
      if (text) textParts.push(text);
      if (thinking) thinkingParts.push(thinking);
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

function clipProgressText(value: string, max = LIVE_PROGRESS_LINE_MAX): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  if (compact.length <= max) {
    return compact;
  }

  const punctuationCut = Math.max(
    compact.lastIndexOf(". ", max),
    compact.lastIndexOf("! ", max),
    compact.lastIndexOf("? ", max),
  );
  if (punctuationCut >= Math.floor(max * 0.55)) {
    return compact.slice(0, punctuationCut + 1).trim();
  }

  const wordCut = compact.lastIndexOf(" ", max - 1);
  const cutAt = wordCut >= Math.floor(max * 0.55) ? wordCut : max - 1;
  return `${compact.slice(0, cutAt).trim()}.`;
}

function cleanProgressLine(value: string): string {
  return String(value ?? "")
    .replace(/^[\s>*\-•↳🧠]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasConcreteProgressDetail(value: string): boolean {
  const text = value.toLowerCase();
  if (/https?:\/\//i.test(value)) {
    return true;
  }
  if (/\b[a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?\b/i.test(value)) {
    return true;
  }
  if (/["“”'][^"“”']{2,}["“”']/.test(value)) {
    return true;
  }
  if (/[/$][A-Za-z0-9_.\-\\/]+/.test(value)) {
    return true;
  }
  if (/\b\d+(?:\.\d+)?%?\b/.test(value)) {
    return true;
  }
  return /\b(page|site|url|file|folder|path|title|price|value|result|results|entry|entries|line|lines|error|code|mfa|login|logout|source|sources|dashboard|portfolio)\b/.test(
    text,
  );
}

function isGenericProgressLine(value: string): boolean {
  const text = cleanProgressLine(value).toLowerCase();
  if (!text) {
    return true;
  }
  if (text.length < 16) {
    return true;
  }
  if (GENERIC_PROGRESS_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  if (!hasConcreteProgressDetail(text)) {
    return /\b(working|checking|looking|continuing|proceeding|planning|thinking|using|handling)\b/.test(text);
  }
  return false;
}

function selectAssistantProgressText(raw: string): string | null {
  const lines = String(raw ?? "")
    .split(/\n+/)
    .map((line) => cleanProgressLine(line))
    .filter(Boolean);
  for (const line of lines) {
    if (isGenericProgressLine(line)) {
      continue;
    }
    return line;
  }
  return null;
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

function normalizeOpenAICompatibleBaseUrl(value: string | undefined): string | undefined {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) {
    return undefined;
  }
  return normalized
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/v1\/chat$/i, "/v1");
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

function resolveModelAlias(params: {
  runtimeProvider: KnownProvider;
  requestedProvider: string;
  modelId: string;
}): string {
  const trimmed = params.modelId.trim();
  if (!trimmed) {
    return params.modelId;
  }
  const canonical = trimmed.toLowerCase();

  if (params.requestedProvider === "deepseek") {
    const deepseekAlias = DEEPSEEK_MODEL_ALIAS_MAP[canonical];
    if (deepseekAlias) {
      return deepseekAlias;
    }
  }

  if (params.runtimeProvider === "openai-codex") {
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

function oneLineError(value: string, maxChars = 320): string {
  const compact = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!compact) {
    return "unknown provider error";
  }
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, maxChars - 3).trim()}...`;
}

function formatProviderRuntimeFailure(params: {
  provider: string;
  model: string;
  endpoint?: string;
  rawError: string;
  availableModels?: string[];
}): string {
  const errorText = oneLineError(params.rawError);
  const endpointHint = params.endpoint ? ` endpoint=${params.endpoint}` : "";
  const availableModelsHint =
    Array.isArray(params.availableModels) && params.availableModels.length > 0
      ? ` Available local models: ${params.availableModels.slice(0, 8).join(", ")}.`
      : "";
  const lower = errorText.toLowerCase();

  if (lower.includes("405")) {
    return `Provider request failed (${params.provider}/${params.model}). Received HTTP 405.${endpointHint} Check the base URL: use an API root like .../v1, not .../v1/chat.`;
  }
  if (lower.includes("openai api key is required")) {
    return `Provider request failed (${params.provider}/${params.model}). The OpenAI-compatible client requires a non-empty API key value for this request path.${endpointHint}`;
  }
  if (lower.includes("no instance found for model") || lower.includes("model") && lower.includes("not found")) {
    return `Provider request failed (${params.provider}/${params.model}). Model id is not available on the local server.${endpointHint}${availableModelsHint} Use an exact model id from GET /v1/models.`;
  }
  return `Provider request failed (${params.provider}/${params.model}). ${errorText}${endpointHint}`;
}

function hasHeaderCaseInsensitive(headers: Record<string, string>, name: string): boolean {
  const target = name.trim().toLowerCase();
  return Object.keys(headers).some((key) => key.trim().toLowerCase() === target);
}

async function discoverLocalOpenAIModels(params: {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}): Promise<string[]> {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  if (!baseUrl) {
    return [];
  }

  const cached = localOpenAIModelDiscoveryCache.get(baseUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return [...cached.models];
  }

  const headers: Record<string, string> = {
    accept: "application/json",
    ...(params.headers ?? {}),
  };
  if (params.apiKey && !hasHeaderCaseInsensitive(headers, "authorization")) {
    headers.authorization = `Bearer ${params.apiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCAL_MODEL_DISCOVERY_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const models = Array.isArray(payload?.data)
      ? payload.data
          .map((entry) => String(entry?.id ?? "").trim())
          .filter(Boolean)
      : [];
    localOpenAIModelDiscoveryCache.set(baseUrl, {
      expiresAt: Date.now() + LOCAL_MODEL_DISCOVERY_TTL_MS,
      models,
    });
    return [...models];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeModelLookupKey(value: string): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function modelIdTail(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "";
  }
  const parts = trimmed.split("/");
  return String(parts[parts.length - 1] ?? "").trim();
}

function modelTokens(value: string): string[] {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function scoreModelSimilarity(requested: string, candidate: string): number {
  const req = String(requested ?? "").trim();
  const cand = String(candidate ?? "").trim();
  if (!req || !cand) {
    return 0;
  }
  const reqLower = req.toLowerCase();
  const candLower = cand.toLowerCase();
  if (reqLower === candLower) {
    return 100;
  }

  let score = 0;
  const reqKey = normalizeModelLookupKey(req);
  const candKey = normalizeModelLookupKey(cand);
  const reqTail = modelIdTail(req);
  const candTail = modelIdTail(cand);
  const reqTailLower = reqTail.toLowerCase();
  const candTailLower = candTail.toLowerCase();
  const reqTailKey = normalizeModelLookupKey(reqTail);
  const candTailKey = normalizeModelLookupKey(candTail);

  if (reqTailLower && reqTailLower === candTailLower) {
    score += 40;
  }
  if (reqTailKey && reqTailKey === candTailKey) {
    score += 35;
  }
  if (reqKey && candKey) {
    if (reqKey === candKey) {
      score += 30;
    } else if (reqKey.includes(candKey) || candKey.includes(reqKey)) {
      score += 20;
    }
  }
  if (reqLower.includes(candLower) || candLower.includes(reqLower)) {
    score += 10;
  }
  if (reqTailLower && candTailLower && (reqTailLower.includes(candTailLower) || candTailLower.includes(reqTailLower))) {
    score += 10;
  }

  const reqTokens = new Set(modelTokens(reqTail || req));
  const candTokens = new Set(modelTokens(candTail || cand));
  let overlap = 0;
  for (const token of reqTokens) {
    if (candTokens.has(token)) {
      overlap += 1;
    }
  }
  score += overlap * 2;
  return score;
}

function remapModelIdFromAvailable(requested: string, available: string[]): string {
  const trimmed = String(requested ?? "").trim();
  if (!trimmed || available.length === 0) {
    return trimmed;
  }

  const lower = trimmed.toLowerCase();
  const exactCaseInsensitive = available.find((entry) => entry.toLowerCase() === lower);
  if (exactCaseInsensitive) {
    return exactCaseInsensitive;
  }

  const requestedKey = normalizeModelLookupKey(trimmed);
  if (!requestedKey) {
    return trimmed;
  }
  const keyMatches = available.filter((entry) => normalizeModelLookupKey(entry) === requestedKey);
  if (keyMatches.length === 1) {
    return keyMatches[0];
  }

  const requestedTail = modelIdTail(trimmed);
  if (requestedTail) {
    const requestedTailLower = requestedTail.toLowerCase();
    const tailCaseInsensitive = available.filter(
      (entry) => modelIdTail(entry).toLowerCase() === requestedTailLower
    );
    if (tailCaseInsensitive.length === 1) {
      return tailCaseInsensitive[0];
    }
    const requestedTailKey = normalizeModelLookupKey(requestedTail);
    const tailKeyMatches = available.filter(
      (entry) => normalizeModelLookupKey(modelIdTail(entry)) === requestedTailKey
    );
    if (tailKeyMatches.length === 1) {
      return tailKeyMatches[0];
    }
  }

  const ranked = available
    .map((entry) => ({ entry, score: scoreModelSimilarity(trimmed, entry) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1];
  if (best && best.score >= 8 && (!second || best.score >= second.score + 4)) {
    return best.entry;
  }

  // If only one model is available on the local server, use it automatically.
  if (available.length === 1) {
    return available[0] ?? trimmed;
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
  mfaPending: boolean;
}): boolean {
  if (params.mfaPending) {
    return false;
  }
  if (
    hasLikelyLoginIntent(params.userMessage) ||
    looksLikeSiteVisitIntent(params.userMessage) ||
    looksLikeAccountDashboardIntent(params.userMessage)
  ) {
    return false;
  }
  const hasWebSearch = hasTool(params.tools, "web_search");
  const hasWebFetch = hasTool(params.tools, "web_fetch");
  if (!hasWebSearch && !hasWebFetch) {
    return false;
  }
  const likelyLookup = /\b(search|look up|lookup|latest|current|today|news|web|internet|url|website|source)\b/i.test(
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

function hasLikelyLoginIntent(message: string): boolean {
  const text = String(message ?? "").toLowerCase();
  if (!text.trim()) {
    return false;
  }
  return (
    /\blogin\b/.test(text) ||
    /\blog\s*in(?:to)?\b/.test(text) ||
    /\blog\s+me\s+in\b/.test(text) ||
    /\bsign\s*in(?:to)?\b/.test(text) ||
    /\bsign\s+me\s+in\b/.test(text) ||
    /\bauth(?:enticate|entication)?\b/.test(text) ||
    /\bverification\b/.test(text) ||
    /\bone[-\s]?time code\b/.test(text) ||
    /\botp\b/.test(text) ||
    /\b2fa\b/.test(text) ||
    /\bmfa\b/.test(text)
  );
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
  const emailIntent =
    /\be-?mails?\b/.test(text) ||
    /\binbox\b/.test(text) ||
    /\bmailbox\b/.test(text) ||
    /\bunread\b/.test(text) ||
    /\bimap\b/.test(text) ||
    /\bsmtp\b/.test(text);
  return (
    /\b(create|make|write|edit|delete|remove|rename|move|copy)\b/.test(text) ||
    /\b(file|folder|directory|desktop|documents|downloads)\b/.test(text) ||
    /\b(run|execute|install|uninstall|start|stop|restart)\b/.test(text) ||
    /\bterminal|shell|command|bash|cd|ls|pwd|cat|npm|pnpm|yarn|git\b/.test(text) ||
    /\b(search|look up|lookup|latest|current|today|news|web|internet|url|website|source)\b/.test(
      text,
    ) ||
    /\b(open|click|navigate|browse|tab|page|site|scrape|crawl|visit|access)\b/.test(text) ||
    /\bgo\s+to\b/.test(text) ||
    /\bgoto\b/.test(text)
    || hasLikelyLoginIntent(text) ||
    /\b(logout|log out|sign out|signout|authenticator|passcode)\b/.test(text) ||
    emailIntent ||
    ((/\breply\b/.test(text) || /\brespond\b/.test(text)) &&
      (/\be-?mails?\b/.test(text) || /\binbox\b/.test(text) || /\bmailbox\b/.test(text))) ||
    hasLikelyLogoutIntent(text) ||
    /\benter (that )?code\b/.test(text)
  );
}

function requestLikelyNeedsCompletionVerification(message: string): boolean {
  const text = String(message ?? "").toLowerCase();
  if (!text.trim()) {
    return false;
  }
  return (
    /\b(create|make|write|edit|update|change|fix|rename|move|copy)\b/.test(text) ||
    /\b(delete|remove|wipe|clear|purge|destroy)\b/.test(text) ||
    /\b(send|submit|post|publish)\b/.test(text) ||
    /\b(install|uninstall|upgrade|downgrade|configure|setup)\b/.test(text) ||
    /\b(login|log in|logout|log out|sign in|sign out|authenticate|mfa|otp)\b/.test(text) ||
    /\b(buy|purchase|checkout|order|pay)\b/.test(text)
  );
}

function toToolArgsRecord(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {};
  }
  return args as Record<string, unknown>;
}

function looksLikeStateMutationCommand(command: string): boolean {
  const text = String(command ?? "").toLowerCase();
  if (!text.trim()) {
    return false;
  }
  return (
    /\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln)\b/.test(text) ||
    /\b(sed|awk|perl)\b/.test(text) ||
    /\b(npm|pnpm|yarn)\s+(install|remove|add|uninstall|update|upgrade|run)\b/.test(text) ||
    /\bgit\s+(add|commit|push|checkout|switch|merge|rebase|reset)\b/.test(text) ||
    /\b(docker|kubectl|systemctl)\b/.test(text) ||
    />>?/.test(text)
  );
}

function looksLikeStateVerificationCommand(command: string): boolean {
  const text = String(command ?? "").toLowerCase();
  if (!text.trim()) {
    return false;
  }
  return (
    /\b(test|stat|ls|find|rg|grep|cat|head|tail|wc|du|md5sum|sha256sum)\b/.test(text) ||
    /\[\s*![^]]*-e/.test(text) ||
    /\[\s*-e/.test(text)
  );
}

function toolCallMutatesState(toolName: string, args: Record<string, unknown>): boolean {
  const normalizedTool = String(toolName ?? "").trim().toLowerCase();
  if (!normalizedTool) {
    return false;
  }
  if (normalizedTool === "write" || normalizedTool === "edit") {
    return true;
  }
  if (
    normalizedTool === "memory_save" ||
    normalizedTool === "memory_delete" ||
    normalizedTool === "memory_prune" ||
    normalizedTool === "memory_feedback" ||
    normalizedTool === "memory_compact"
  ) {
    return true;
  }
  if (normalizedTool === "email") {
    const action = String(args.action ?? "").trim().toLowerCase();
    return action === "send";
  }
  if (normalizedTool === "browser") {
    const action = String(args.action ?? "").trim().toLowerCase();
    return (
      action === "submit" ||
      action === "login" ||
      action === "mfa" ||
      action === "upload" ||
      action === "dialog" ||
      action === "challenge"
    );
  }
  if (normalizedTool === "exec") {
    const command = String(args.command ?? args.cmd ?? "");
    return looksLikeStateMutationCommand(command);
  }
  return false;
}

function toolCallVerifiesState(toolName: string, args: Record<string, unknown>): boolean {
  const normalizedTool = String(toolName ?? "").trim().toLowerCase();
  if (!normalizedTool) {
    return false;
  }
  if (
    normalizedTool === "read" ||
    normalizedTool === "ls" ||
    normalizedTool === "find" ||
    normalizedTool === "exists" ||
    normalizedTool === "web_search" ||
    normalizedTool === "web_fetch" ||
    normalizedTool === "memory_search" ||
    normalizedTool === "memory_get" ||
    normalizedTool === "memory_save" ||
    normalizedTool === "memory_delete" ||
    normalizedTool === "memory_prune" ||
    normalizedTool === "memory_feedback" ||
    normalizedTool === "memory_compact" ||
    normalizedTool === "memory_list" ||
    normalizedTool === "memory_stats"
  ) {
    return true;
  }
  if (normalizedTool === "email") {
    const action = String(args.action ?? "").trim().toLowerCase();
    return (
      action === "status" ||
      action === "list_unread" ||
      action === "read_unread" ||
      action === "read_recent" ||
      action === "send"
    );
  }
  if (normalizedTool === "browser") {
    const action = String(args.action ?? "").trim().toLowerCase();
    return (
      action === "snapshot" ||
      action === "wait" ||
      action === "wait_for_request" ||
      action === "downloads" ||
      action === "console" ||
      action === "pdf"
    );
  }
  if (normalizedTool === "exec") {
    const command = String(args.command ?? args.cmd ?? "");
    return looksLikeStateVerificationCommand(command);
  }
  return false;
}

function buildCompletionVerificationInstruction(): string {
  return [
    "System instruction: do not finalize yet.",
    "A state-changing step needs direct post-action verification before any completion claim.",
    "Run verification now (for filesystem use explicit existence/list checks; for web/app use snapshot/readback/status evidence), then summarize only verified results.",
  ].join(" ");
}

function messageLikelyNeedsEmailTool(message: string): boolean {
  const text = String(message ?? "").toLowerCase();
  if (!text.trim()) {
    return false;
  }
  const emailIntent =
    /\be-?mails?\b/.test(text) ||
    /\binbox\b/.test(text) ||
    /\bmailbox\b/.test(text) ||
    /\bunread\b/.test(text) ||
    /\bimap\b/.test(text) ||
    /\bsmtp\b/.test(text);
  return (
    emailIntent ||
    /\bsend (an )?e-?mails?\b/.test(text) ||
    /\bcheck (my|the)?\s*inbox\b/.test(text) ||
    ((/\breply\b/.test(text) || /\brespond\b/.test(text)) &&
      (/\be-?mails?\b/.test(text) || /\binbox\b/.test(text) || /\bmailbox\b/.test(text)))
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

function extractOneTimeCodeCandidatesFromText(text: string): string[] {
  const source = String(text ?? "");
  if (!source.trim()) {
    return [];
  }
  const candidates: Array<{ value: string; score: number }> = [];
  const push = (value: string, score: number) => {
    const normalized = String(value ?? "").trim();
    if (!normalized || normalized.length < 4 || normalized.length > 10) {
      return;
    }
    if (!/^[a-z0-9]+$/i.test(normalized)) {
      return;
    }
    if (!/\d/.test(normalized)) {
      return;
    }
    candidates.push({ value: normalized, score });
  };

  const contextual = /(?:verification|one[-\s]?time|security|login|sign[-\s]?in|otp|mfa|2fa|auth(?:entication)?)\D{0,24}([a-z0-9]{4,10})/gi;
  for (const match of source.matchAll(contextual)) {
    const value = String(match[1] ?? "").trim();
    let score = 10;
    if (/^\d+$/.test(value)) {
      score += value.length === 6 ? 5 : value.length === 8 ? 4 : 2;
    }
    push(value, score);
  }

  const genericNumeric = /\b(\d{4,10})\b/g;
  for (const match of source.matchAll(genericNumeric)) {
    const value = String(match[1] ?? "").trim();
    let score = 2;
    if (value.length === 6) {
      score += 4;
    } else if (value.length === 8) {
      score += 3;
    }
    push(value, score);
  }

  const genericAlphaNum = /\b([a-z0-9]{6,10})\b/gi;
  for (const match of source.matchAll(genericAlphaNum)) {
    const value = String(match[1] ?? "").trim();
    if (!/\d/.test(value)) {
      continue;
    }
    push(value, 1);
  }

  const best = new Map<string, number>();
  for (const candidate of candidates) {
    const prev = best.get(candidate.value) ?? Number.NEGATIVE_INFINITY;
    if (candidate.score > prev) {
      best.set(candidate.value, candidate.score);
    }
  }
  return Array.from(best.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([value]) => value);
}

function extractLikelyOneTimeCodeFromEmailOutcome(content: string): string | null {
  const parsed = parseJsonRecord(content);
  const sourceTexts: string[] = [];
  if (parsed) {
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    for (const entry of messages) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const row = entry as Record<string, unknown>;
      sourceTexts.push(
        String(row.subject ?? ""),
        String(row.snippet ?? ""),
      );
    }
    sourceTexts.push(String(parsed.reason ?? ""), String(parsed.nextStep ?? ""));
  }
  if (sourceTexts.length === 0) {
    sourceTexts.push(String(content ?? ""));
  }
  for (const text of sourceTexts) {
    const candidates = extractOneTimeCodeCandidatesFromText(text);
    if (candidates.length > 0) {
      return candidates[0] ?? null;
    }
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

function shortUrlForProgress(raw: string): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    return "";
  }
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./i, "");
    const first = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    return first ? `${host}/${first.slice(0, 24)}` : host;
  } catch {
    return value.length > 72 ? `${value.slice(0, 69)}...` : value;
  }
}

function firstSentence(text: string, max = 180): string {
  const compact = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  const punct = compact.search(/[.!?](\s|$)/);
  const base = punct >= 0 ? compact.slice(0, punct + 1).trim() : compact;
  if (base.length <= max) {
    return base;
  }
  const cut = base.lastIndexOf(" ", max - 1);
  const end = cut >= Math.floor(max * 0.6) ? cut : max - 1;
  return `${base.slice(0, end).trim()}...`;
}

function summarizeArgsForProgress(toolName: string, args: unknown): string | null {
  const params =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const url = String(params.url ?? params.targetUrl ?? "").trim();
  const query = String(params.query ?? "").trim();
  const path = String(params.path ?? "").trim();
  const service = String(params.service ?? "").trim();
  const action = String(params.action ?? "").trim().toLowerCase();
  const command = String(params.command ?? "").trim();

  if (toolName === "browser") {
    if (action === "login" && service) {
      return `I'm attempting sign-in for ${service} now.`;
    }
    if (action === "mfa") {
      return "I'm submitting the one-time code and checking whether access is granted.";
    }
    if (query) {
      return `I'm searching for "${query}" to find the strongest source.`;
    }
    if (url) {
      return `I'm opening ${shortUrlForProgress(url)} and checking the relevant details.`;
    }
    if (action === "snapshot") {
      return "I'm capturing the current page state so I can target the right next click.";
    }
    if (action === "click") {
      return "I'm clicking the selected page element and checking where it leads.";
    }
    if (action === "fill") {
      return "I'm filling the visible form field and then validating the page response.";
    }
    if (action === "submit") {
      return "I'm submitting the current form and checking whether the next page confirms success.";
    }
    if (action === "open") {
      return "I'm loading the requested page and checking what is visible there.";
    }
    return null;
  }
  if (toolName === "web_search") {
    if (query) {
      return `I'm searching for "${query}" and evaluating the top sources.`;
    }
    return null;
  }
  if (toolName === "web_fetch") {
    if (url) {
      return `I'm reading ${shortUrlForProgress(url)} for concrete details.`;
    }
    return null;
  }
  if (toolName === "memory_search") {
    if (query) {
      return `I'm searching saved memory for "${query}" and then I'll pull exact snippets to verify.`;
    }
    return "I'm searching saved memory for relevant context before I answer.";
  }
  if (toolName === "memory_get") {
    const ref = String(params.ref ?? params.id ?? "").trim();
    if (ref) {
      return `I'm pulling the exact memory snippet from ${ref} so I can answer precisely.`;
    }
    if (path) {
      return `I'm reading ${path} to pull the exact memory lines we need.`;
    }
    return "I'm pulling the exact memory snippet needed for this step.";
  }
  if (toolName === "memory_save") {
    const title = String(params.title ?? "").trim();
    if (title) {
      return `I'm saving a durable memory note titled "${title}" so I can reuse it in future tasks.`;
    }
    return "I'm saving this as durable memory so I can reuse it later.";
  }
  if (toolName === "memory_delete") {
    const ref = String(params.ref ?? params.id ?? "").trim();
    const title = String(params.title ?? "").trim();
    if (ref) {
      return `I'm deleting the outdated memory entry ${ref} so future replies don't reuse it.`;
    }
    if (title) {
      return `I'm deleting the outdated memory entry titled "${title}".`;
    }
    return "I'm deleting outdated memory so future replies stay accurate.";
  }
  if (toolName === "memory_list") {
    if (query) {
      return `I'm auditing saved memory entries matching "${query}" to verify what is currently stored.`;
    }
    return "I'm auditing saved memory entries so we can review memory quality.";
  }
  if (toolName === "memory_prune") {
    const maxEntries = String(params.maxEntries ?? "").trim();
    const olderThanDays = String(params.olderThanDays ?? "").trim();
    const dryRun = params.dryRun !== false;
    if (maxEntries || olderThanDays) {
      const clauses = [
        maxEntries ? `keep newest ${maxEntries}` : "",
        olderThanDays ? `remove older than ${olderThanDays} days` : "",
      ].filter(Boolean);
      return dryRun
        ? `I'm running a retention dry-run (${clauses.join(", ")}) to preview prune impact safely.`
        : `I'm applying retention cleanup (${clauses.join(", ")}) to remove stale memory entries.`;
    }
    return dryRun
      ? "I'm running a dry-run retention check to preview stale memory cleanup."
      : "I'm applying retention cleanup to stale memory.";
  }
  if (toolName === "memory_compact") {
    const dryRun = params.dryRun !== false;
    return dryRun
      ? "I'm running a storage compaction dry-run to estimate how much memory history can be cleaned."
      : "I'm compacting the durable memory store to remove stale history rows and improve performance.";
  }
  if (toolName === "memory_feedback") {
    const signal = String(params.signal ?? "").trim().toLowerCase();
    const ref = String(params.ref ?? params.id ?? "").trim();
    if (ref && signal) {
      return `I'm applying ${signal} feedback to ${ref} so future memory ranking reflects this signal.`;
    }
    return "I'm applying memory feedback to improve future retrieval quality.";
  }
  if (toolName === "memory_stats") {
    const namespace = String(params.namespace ?? "").trim();
    if (namespace) {
      return `I'm auditing memory quality metrics for namespace "${namespace}" to identify stale or noisy context.`;
    }
    return "I'm auditing global memory quality metrics to identify stale or noisy context.";
  }
  if (toolName === "read" && path) {
    return `I'm opening ${path} to inspect what it contains.`;
  }
  if ((toolName === "find" || toolName === "ls" || toolName === "exists") && path) {
    return `I'm checking ${path} to locate the right file or data.`;
  }
  if ((toolName === "write" || toolName === "edit") && path) {
    return `I'm updating ${path} and then verifying the change.`;
  }
  if (toolName === "exec" && command) {
    return `I'm running a workspace command and checking the output: ${firstSentence(command, 120)}`;
  }
  if (toolName === "process") {
    return "I'm checking the background task state and output.";
  }
  return null;
}

function summarizeOutcomeForProgress(params: {
  toolName: string;
  content: string;
  isError: boolean;
}): string | null {
  if (params.isError) {
    const err = summarizeToolContent(params.content);
    if (params.toolName === "browser") {
      return `The page interaction failed with: ${err}. I'll try a different navigation path.`;
    }
    if (params.toolName === "read" || params.toolName === "write" || params.toolName === "edit") {
      return `The file step failed with: ${err}. I'll adjust the approach and retry safely.`;
    }
    return `That step failed with: ${err}. I'll try a different path.`;
  }

  const raw = String(params.content ?? "").trim();
  if (!raw) {
    return null;
  }
  const parsed = parseJsonRecord(raw);
  if (parsed) {
    if (params.toolName === "memory_search") {
      const results = Array.isArray(parsed.results) ? parsed.results : [];
      const searched = getNestedRecord(parsed, "searched");
      const storeEntriesScanned = Number(searched?.storeEntriesScanned ?? 0);
      const filesScanned = Number(searched?.filesScanned ?? 0);
      if (results.length > 0) {
        const top = results[0];
        if (top && typeof top === "object") {
          const row = top as Record<string, unknown>;
          const topRef = String(row.ref ?? "").trim();
          const topPreview = firstSentence(String(row.preview ?? "").trim(), 130);
          if (topRef && topPreview) {
            return `I found ${results.length} relevant memory matches (scanned ${storeEntriesScanned} saved entries and ${filesScanned} memory files). Top match ${topRef} says: ${topPreview} Next I'll pull the exact lines I need.`;
          }
          if (topRef) {
            return `I found ${results.length} relevant memory matches (scanned ${storeEntriesScanned} saved entries and ${filesScanned} memory files), with ${topRef} as the strongest lead. Next I'll pull exact lines.`;
          }
        }
        return `I found ${results.length} relevant memory matches. Next I'll pull the exact snippet to ground the answer.`;
      }
      return `I searched memory (scanned ${storeEntriesScanned} saved entries and ${filesScanned} memory files) but didn't find a strong match yet. I'll continue with fresh evidence.`;
    }
    if (params.toolName === "memory_get") {
      const source = String(parsed.source ?? "").trim().toLowerCase();
      const ref = String(parsed.ref ?? "").trim();
      const content = firstSentence(String(parsed.content ?? "").trim(), 150);
      if (ref && content) {
        return `I pulled ${ref} from ${source || "memory"} and it states: ${content} I'll use this directly in the answer.`;
      }
      if (ref) {
        return `I pulled exact memory from ${ref} and I'm now applying it to your request.`;
      }
      if (content) {
        return `I pulled exact memory details: ${content} I'll apply this to your request now.`;
      }
    }
    if (params.toolName === "memory_save") {
      const ref = String(parsed.ref ?? "").trim();
      const title = String(parsed.title ?? "").trim();
      const upserted = parsed.upserted === true;
      const conflictDetected = parsed.conflictDetected === true;
      const replacedIds = Array.isArray(parsed.replacedIds) ? parsed.replacedIds.length : 0;
      const evictedIds = Array.isArray(parsed.evictedIds) ? parsed.evictedIds.length : 0;
      if (ref && title) {
        if (replacedIds > 0) {
          return `I replaced ${replacedIds} conflicting memory entr${replacedIds === 1 ? "y" : "ies"} and saved the new canonical note (${title}, ${ref}).`;
        }
        if (conflictDetected) {
          return `I saved memory (${title}, ${ref}) and flagged a potential contradiction so we can replace stale context if needed.`;
        }
        if (evictedIds > 0) {
          return `I saved memory (${title}, ${ref}) and evicted ${evictedIds} low-priority entries to satisfy namespace quota.`;
        }
        return upserted
          ? `I updated durable memory (${title}, ${ref}) so it reflects the latest context.`
          : `I saved this as durable memory (${title}, ${ref}) so I can reuse it in future tasks.`;
      }
      if (ref) {
        if (replacedIds > 0) {
          return `I replaced conflicting memory and saved the new canonical entry (${ref}).`;
        }
        if (conflictDetected) {
          return `I saved memory (${ref}) and flagged a potential contradiction for review.`;
        }
        if (evictedIds > 0) {
          return `I saved memory (${ref}) and evicted ${evictedIds} low-priority entries to satisfy namespace quota.`;
        }
        return upserted
          ? `I updated durable memory (${ref}) with the latest details.`
          : `I saved this as durable memory (${ref}) so it's available for future tasks.`;
      }
      return "I saved this as durable memory so I can recall it later.";
    }
    if (params.toolName === "memory_delete") {
      const ref = String(parsed.ref ?? "").trim();
      const title = String(parsed.title ?? "").trim();
      if (ref && title) {
        return `I deleted outdated memory (${title}, ${ref}) so it won't influence future replies.`;
      }
      if (ref) {
        return `I deleted outdated memory (${ref}) so it won't influence future replies.`;
      }
      return "I deleted the outdated memory entry.";
    }
    if (params.toolName === "memory_list") {
      const total = Number(parsed.total ?? 0);
      const returned = Array.isArray(parsed.results) ? parsed.results.length : 0;
      const scanned = Number(parsed.scanned ?? 0);
      if (returned > 0) {
        return `I audited durable memory and found ${total} matching entries (returned ${returned}, scanned ${scanned}). I'll use this to tighten memory quality and recall behavior.`;
      }
      return `I audited durable memory (scanned ${scanned}) and found no matching entries for that filter.`;
    }
    if (params.toolName === "memory_prune") {
      const dryRun = parsed.dryRun !== false;
      const wouldPrune = Number(parsed.wouldPrune ?? 0);
      const pruned = Number(parsed.pruned ?? 0);
      const scanned = Number(parsed.scanned ?? 0);
      if (dryRun) {
        return `Retention dry-run complete: ${wouldPrune} of ${scanned} entries would be pruned.`;
      }
      return `Retention cleanup complete: pruned ${pruned} entries (scanned ${scanned}).`;
    }
    if (params.toolName === "memory_compact") {
      const dryRun = parsed.dryRun !== false;
      const reclaimedLines = Number(parsed.reclaimedLines ?? 0);
      const linesBefore = Number(parsed.linesBefore ?? 0);
      const linesAfter = Number(parsed.linesAfter ?? 0);
      if (dryRun) {
        return `Compaction dry-run complete: ${reclaimedLines} history rows can be removed (${linesBefore} -> ${linesAfter}).`;
      }
      return `Memory compaction complete: removed ${reclaimedLines} stale rows (${linesBefore} -> ${linesAfter}).`;
    }
    if (params.toolName === "memory_feedback") {
      const signal = String(parsed.signal ?? "").trim();
      const ref = String(parsed.ref ?? "").trim();
      const reinforceCount = Number(parsed.reinforceCount ?? 0);
      if (ref && signal) {
        return `Memory feedback applied (${signal}) to ${ref}; reinforcement score is now ${reinforceCount}.`;
      }
      return "Memory feedback applied to improve future retrieval ranking.";
    }
    if (params.toolName === "memory_stats") {
      const totals = getNestedRecord(parsed, "totals");
      const filteredEntries = Number(totals?.filteredEntries ?? 0);
      const namespaces = Number(totals?.namespaces ?? 0);
      const stale = Array.isArray(parsed.staleCandidates) ? parsed.staleCandidates.length : 0;
      return `Memory analytics complete: ${filteredEntries} active entries across ${namespaces} namespace(s), with ${stale} stale candidates flagged.`;
    }

    const mfa = getNestedRecord(parsed, "mfa");
    const requiresMfa =
      parsed.requiresMfa === true || mfa?.required === true || mfa?.requiresMfa === true;
    if (requiresMfa) {
      return "I found that this sign-in requires a one-time code, so I'm waiting for your code.";
    }

    const snapshot = getNestedRecord(parsed, "snapshot") ?? getNestedRecord(parsed, "openedSnapshot");
    const snapUrl = String(snapshot?.url ?? getNestedRecord(parsed, "tab")?.url ?? parsed.url ?? "").trim();
    const snapTitle = String(snapshot?.title ?? getNestedRecord(parsed, "tab")?.title ?? "").trim();
    if (snapUrl && snapTitle) {
      return `I reached ${shortUrlForProgress(snapUrl)} and the page shows "${firstSentence(snapTitle, 90)}". I'm now checking whether this matches your target.`;
    }
    if (snapUrl) {
      return `I reached ${shortUrlForProgress(snapUrl)} and captured the latest page state. I'm now validating the key details.`;
    }

    if (Array.isArray(parsed.results) && parsed.results.length > 0) {
      const top = parsed.results[0];
      if (top && typeof top === "object") {
        const row = top as Record<string, unknown>;
        const title = firstSentence(String(row.title ?? "").trim(), 90);
        const url = shortUrlForProgress(String(row.url ?? "").trim());
        if (title && url) {
          return `I found several sources; the strongest lead right now is "${title}" on ${url}. I'll verify it before finalizing.`;
        }
      }
      return `I found ${parsed.results.length} potential sources and I'm now verifying the strongest one.`;
    }

    const readPath = String(parsed.path ?? "").trim();
    if (readPath && typeof parsed.content === "string") {
      return `I found ${readPath} and reviewed its contents. I'm now checking it against your request.`;
    }
    if (readPath && typeof parsed.bytes === "number") {
      return `I updated ${readPath} (${parsed.bytes} bytes). I'm now validating the result.`;
    }
    if (Array.isArray(parsed.entries)) {
      return `I checked that location and found ${parsed.entries.length} entries. I'm narrowing to the relevant item now.`;
    }
    const fetchedText = String(parsed.text ?? "").trim();
    if (fetchedText) {
      const summary = firstSentence(fetchedText, 160);
      const source = String(parsed.url ?? "").trim();
      if (source) {
        return `I pulled details from ${shortUrlForProgress(source)}: ${summary} I'm cross-checking this before finalizing.`;
      }
      return `I pulled a concrete detail: ${summary} I'm cross-checking this before finalizing.`;
    }
  }
  if (/^[\[{]/.test(raw)) {
    return null;
  }

  const summary = firstSentence(raw, 170);
  if (!summary || isGenericProgressLine(summary)) {
    return null;
  }
  const normalized = /[.!?]$/.test(summary) ? summary : `${summary}.`;
  if (!hasConcreteProgressDetail(normalized)) {
    return null;
  }
  return `${normalized} I'll validate this against the other evidence next.`;
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
  const mfaSourceService = String(parsed.mfaSourceService ?? mfaRecord?.sourceService ?? "").trim();
  pendingMfaBySession.set(params.sessionId, {
    ...(service ? { service } : {}),
    ...(mfaSourceService ? { mfaSourceService } : {}),
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

function parseBrowserMfaState(outcomeContent: string): {
  requiresMfa: boolean;
  mfaSourceService: string | null;
  mfaSourceCredentialAvailable: boolean;
} {
  const parsed = parseJsonRecord(outcomeContent);
  if (!parsed) {
    return {
      requiresMfa: false,
      mfaSourceService: null,
      mfaSourceCredentialAvailable: false,
    };
  }
  const mfaRecord = getNestedRecord(parsed, "mfa");
  const requiresMfa =
    parsed.requiresMfa === true ||
    mfaRecord?.required === true ||
    mfaRecord?.requiresMfa === true;
  const mfaSourceServiceRaw = String(parsed.mfaSourceService ?? mfaRecord?.sourceService ?? "").trim();
  const mfaSourceService = mfaSourceServiceRaw || null;
  const mfaSourceCredentialAvailable =
    parsed.mfaSourceCredentialAvailable === true ||
    mfaRecord?.sourceCredentialAvailable === true;
  return {
    requiresMfa,
    mfaSourceService,
    mfaSourceCredentialAvailable,
  };
}

function parseBrowserLoginState(outcomeContent: string): {
  submitted: boolean;
  requiresMfa: boolean;
  mfaExpected: boolean;
  identifier: string | null;
} | null {
  const parsed = parseJsonRecord(outcomeContent);
  if (!parsed) {
    return null;
  }
  const mfaRecord = getNestedRecord(parsed, "mfa");
  const hasLoginShape =
    "submitted" in parsed ||
    "requiresMfa" in parsed ||
    "mfaExpected" in parsed ||
    "identifier" in parsed ||
    mfaRecord !== null;
  if (!hasLoginShape) {
    return null;
  }
  const identifierRaw = String(parsed.identifierFull ?? parsed.identifier ?? parsed.identifierMasked ?? "").trim();
  return {
    submitted: parsed.submitted === true,
    requiresMfa:
      parsed.requiresMfa === true ||
      mfaRecord?.required === true ||
      mfaRecord?.requiresMfa === true,
    mfaExpected: parsed.mfaExpected === true || mfaRecord?.expected === true,
    identifier: identifierRaw || null,
  };
}

function normalizeBrowserActionName(value: unknown): string {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (raw === "wait-for-request" || raw === "waitforrequest" || raw === "wait-for-network") {
    return "wait_for_request";
  }
  if (raw === "captcha" || raw === "human-check" || raw === "human_check" || raw === "human-verification") {
    return "challenge";
  }
  return raw;
}

function parseBrowserChallengeState(outcomeContent: string): {
  detected: boolean;
  tabId: string | null;
} {
  const parsed = parseJsonRecord(outcomeContent);
  if (!parsed) {
    return {
      detected: false,
      tabId: null,
    };
  }
  const challengeRecord = getNestedRecord(parsed, "challenge");
  const tabRecord = getNestedRecord(parsed, "tab");
  const detected =
    parsed.humanVerificationRequired === true ||
    parsed.challengeDetected === true ||
    challengeRecord?.detected === true;
  const tabIdRaw = String(parsed.activeTabId ?? tabRecord?.id ?? "").trim();
  return {
    detected,
    tabId: tabIdRaw || null,
  };
}

function outcomeLooksLikeHumanVerificationError(outcomeContent: string): boolean {
  const text = String(outcomeContent ?? "").toLowerCase();
  return /\b(captcha|recaptcha|hcaptcha|turnstile|human verification|verify you are human|security check|cloudflare)\b/.test(
    text,
  );
}

function buildAutoMfaFromEmailInstruction(params: {
  sourceService: string;
  pending: PendingMfaSession | undefined;
}): string {
  const tabPart = params.pending?.tabId ? `, tabId="${params.pending.tabId}"` : "";
  const servicePart = params.pending?.service ? `, service="${params.pending.service}"` : "";
  return [
    "System instruction: login reached MFA challenge and mailbox access is configured.",
    `Use email tool now with action="list_unread" and service="${params.sourceService}" to fetch the latest one-time code.`,
    "Extract the code, then immediately call browser tool action=\"mfa\" with that code",
    `${tabPart}${servicePart}.`,
    "If no usable code is found in email, ask the user for the one-time code in one short line and stop.",
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
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
    `${params.pending.mfaSourceService ? `Prefer MFA inbox source service="${params.pending.mfaSourceService}" when a retrieval step is needed.` : ""}`,
    "Do not ask the user to repeat this same code.",
  ]
    .join(" ")
    .trim();
  return `${actionLine}\nOriginal user message: ${params.userMessage}`;
}

function looksLikeLoginIntent(message: string): boolean {
  return hasLikelyLoginIntent(message);
}

function looksLikeAccountDashboardIntent(message: string): boolean {
  const text = String(message ?? "").toLowerCase();
  if (!text.trim()) {
    return false;
  }
  return (
    /\bdashboard\b/.test(text) ||
    /\bbalance\b/.test(text) ||
    /\baccount\b/.test(text) ||
    /\bportfolio\b/.test(text) ||
    /\bstatement\b/.test(text)
  );
}

function messageLikelyAsksToContinueWithoutCode(message: string): boolean {
  const text = String(message ?? "").toLowerCase();
  if (!text.trim()) {
    return false;
  }
  return (
    /\b(continue|proceed|go ahead|keep going|next step|do it|finish)\b/.test(text) ||
    looksLikeLoginIntent(text) ||
    looksLikeAccountDashboardIntent(text)
  );
}

function looksLikeMfaRecoveryIntent(message: string): boolean {
  const text = String(message ?? "").toLowerCase();
  if (!text.trim()) {
    return false;
  }
  if (
    /\b(what|which)\s+email\b/.test(text) ||
    /\b(email|address)\b[\s\S]{0,40}\b(enter|entered|use|used|fill|filled|typed|typing)\b/.test(text)
  ) {
    return true;
  }
  const codeTerms = /\b(one[-\s]?time code|otp|verification code|auth code|2fa code|mfa code|code)\b/.test(text);
  if (!codeTerms) {
    return false;
  }
  return (
    /\b(not getting|not receiving|didn['’]?t get|never got|no code|code not|missing)\b/.test(text) ||
    /\b(resend|send again|retry|try again)\b/.test(text)
  );
}

function extractHttpUrlsFromText(message: string): string[] {
  const text = String(message ?? "");
  if (!text.trim()) {
    return [];
  }
  const matches = text.match(/https?:\/\/[^\s"'`<>]+/gi) ?? [];
  const out: string[] = [];
  for (const raw of matches) {
    const cleaned = raw.trim();
    if (!cleaned) {
      continue;
    }
    try {
      const normalized = new URL(cleaned).toString();
      if (!out.includes(normalized)) {
        out.push(normalized);
      }
    } catch {
      // ignore invalid URL fragments
    }
  }
  return out;
}

function extractLikelyDomainsFromText(message: string): string[] {
  const text = String(message ?? "");
  if (!text.trim()) {
    return [];
  }
  const compacted = text.replace(/([a-z0-9])\s*([.-])\s*(?=[a-z0-9])/gi, "$1$2");
  const matches = compacted.match(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi) ?? [];
  const out: string[] = [];
  for (const raw of matches) {
    const host = raw.trim().toLowerCase().replace(/^www\./, "");
    if (!host) {
      continue;
    }
    if (!out.includes(host)) {
      out.push(host);
    }
  }
  return out;
}

function normalizeServiceFingerprint(value: string): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isGenericServiceName(service: string): boolean {
  const normalized = normalizeSetupService(service) ?? "";
  return normalized === "email" || normalized === "mail" || normalized === "x.com";
}

function hostFromWebsiteUrl(value: string): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  try {
    return new URL(raw).hostname.trim().toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function extractTargetUrlFromMessage(message: string): string | null {
  const explicit = extractHttpUrlsFromText(message)[0];
  if (explicit) {
    return explicit;
  }
  const domain = extractLikelyDomainsFromText(message)[0];
  if (!domain) {
    return null;
  }
  return `https://${domain}`;
}

function looksLikeSiteVisitIntent(message: string): boolean {
  const text = String(message ?? "").toLowerCase();
  if (!text.trim()) {
    return false;
  }
  const hasSite = extractHttpUrlsFromText(message).length > 0 || extractLikelyDomainsFromText(message).length > 0;
  if (!hasSite) {
    return false;
  }
  return (
    /\b(go to|goto|open|visit|navigate|check|load|access)\b/.test(text) ||
    hasLikelyLoginIntent(text) ||
    looksLikeAccountDashboardIntent(text)
  );
}

function assistantRefusedOtpRelay(text: string): boolean {
  const normalized = String(text ?? "").toLowerCase();
  if (!normalized.trim()) {
    return false;
  }
  return (
    /can(?:not|'t)\s+(?:relay|provide|share|send)\s+(?:any\s+)?(?:one[-\s]?time|otp|verification)\s+(?:password|code|codes)/.test(
      normalized,
    ) ||
    /one[-\s]?time\s+(?:password|code).*treated as sensitive/.test(normalized)
  );
}

function inferTargetUrlFromService(service: string): string | null {
  const normalized = normalizeSetupService(service);
  if (!normalized || !normalized.includes(".")) {
    return null;
  }
  return `https://${normalized}`;
}

async function resolveSavedServiceFromUserMessage(params: {
  workspaceDir: string;
  message: string;
}): Promise<string | null> {
  const candidates = new Set<string>();
  const add = (value: string) => {
    const normalized = normalizeSetupService(value);
    if (normalized) {
      candidates.add(normalized);
    }
  };

  const urls = extractHttpUrlsFromText(params.message);
  for (const url of urls) {
    try {
      const host = new URL(url).hostname.trim().toLowerCase().replace(/^www\./, "");
      if (!host) {
        continue;
      }
      add(host);
      const first = host.split(".")[0] ?? "";
      if (first) {
        add(first);
      }
    } catch {
      // ignore
    }
  }
  const domains = extractLikelyDomainsFromText(params.message);
  for (const domain of domains) {
    add(domain);
    const first = domain.split(".")[0] ?? "";
    if (first) {
      add(first);
    }
  }

  const textTokens = String(params.message ?? "")
    .toLowerCase()
    .split(/[^a-z0-9._-]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
  for (const token of textTokens) {
    if (token.length < 3) {
      continue;
    }
    if (token.includes("-") || token.includes(".") || /vault|bank|finance|account|mail/.test(token)) {
      add(token);
    }
  }

  for (const service of candidates) {
    const credential = await getCredential({
      workspaceDir: params.workspaceDir,
      service,
    });
    if (credential) {
      return service;
    }
  }

  const messageFingerprint = normalizeServiceFingerprint(
    String(params.message ?? "").replace(/([a-z0-9])\s*([.-])\s*(?=[a-z0-9])/gi, "$1$2"),
  );
  if (!messageFingerprint) {
    return null;
  }
  const configured = await listConfiguredServices(params.workspaceDir);
  for (const service of configured) {
    if (isGenericServiceName(service)) {
      continue;
    }
    const serviceFingerprint = normalizeServiceFingerprint(service);
    if (serviceFingerprint.length >= 8 && messageFingerprint.includes(serviceFingerprint)) {
      return service;
    }
    const credential = await getCredential({
      workspaceDir: params.workspaceDir,
      service,
    });
    const websiteHost = hostFromWebsiteUrl(String(credential?.websiteUrl ?? ""));
    const websiteFingerprint = normalizeServiceFingerprint(websiteHost ?? "");
    if (websiteFingerprint.length >= 8 && messageFingerprint.includes(websiteFingerprint)) {
      return service;
    }
  }
  return null;
}

function assistantIsAskingForIdentifier(text: string): boolean {
  const normalized = String(text ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    /\b(which|what)\s+(email|username)\b/.test(normalized) ||
    /\bwhat\s+email\s+address\b/.test(normalized) ||
    /\bneed (?:the )?(?:exact )?(email|username)\b/.test(normalized) ||
    /\bjust need (?:your )?(email|username)\b/.test(normalized) ||
    /\bneed .* (email|username) .* (enter|use|send)\b/.test(normalized) ||
    /\bemail address (?:to use|you(?:'|’)d like|for this)\b/.test(normalized) ||
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

function extractUrlFromBrowserOutcomeContent(content: string): string | null {
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
      const normalized = new URL(raw).toString();
      if (normalized) {
        return normalized;
      }
    } catch {
      // ignore invalid URL fragments
    }
  }
  return null;
}

function latestBrowserUrlFromToolOutcomes(
  toolOutcomes: Array<{ toolName: string; isError: boolean; content: string }>,
): string | null {
  const successfulBrowserOutcomes = toolOutcomes
    .filter((entry) => !entry.isError && String(entry.toolName ?? "").trim().toLowerCase() === "browser")
    .slice()
    .reverse();
  for (const outcome of successfulBrowserOutcomes) {
    const url = extractUrlFromBrowserOutcomeContent(outcome.content);
    if (url) {
      return url;
    }
  }
  return null;
}

function enrichCheckoutArgsWithPageContext(params: {
  toolName: string;
  toolArgs: unknown;
  toolOutcomes: Array<{ toolName: string; isError: boolean; content: string }>;
}): unknown {
  if (String(params.toolName ?? "").trim().toLowerCase() !== "browser") {
    return params.toolArgs;
  }
  if (!params.toolArgs || typeof params.toolArgs !== "object" || Array.isArray(params.toolArgs)) {
    return params.toolArgs;
  }
  const args = params.toolArgs as Record<string, unknown>;
  const action = String(args.action ?? "").trim().toLowerCase();
  if (!action || !["click", "submit", "act", "press"].includes(action)) {
    return params.toolArgs;
  }
  const knownUrl =
    String(args.currentUrl ?? "").trim() ||
    String(args.currentPageUrl ?? "").trim() ||
    String(args.url ?? "").trim() ||
    String(args.targetUrl ?? "").trim();
  if (knownUrl) {
    return params.toolArgs;
  }
  const latestUrl = latestBrowserUrlFromToolOutcomes(params.toolOutcomes);
  if (!latestUrl) {
    return params.toolArgs;
  }
  return {
    ...args,
    currentPageUrl: latestUrl,
  };
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

const SMALL_TALK_PATTERNS: RegExp[] = [
  /^(?:hi|hello|hey)(?: there)?(?: how are you(?: today| doing)?)?$/,
  /^how are you(?: today| doing)?$/,
  /^(?:what's up|whats up|how's it going|hows it going)$/,
  /^(?:good morning|good afternoon|good evening|good night)$/,
];

type IdentityAnchors = {
  assistantName: string | null;
  userName: string | null;
};

type IdentityIntent = {
  askAssistant: boolean;
  askUser: boolean;
};

function normalizeSimpleMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSmallTalkMessage(message: string): boolean {
  const normalized = normalizeSimpleMessage(message);
  if (!normalized) {
    return false;
  }
  if (normalized.split(" ").length > 10) {
    return false;
  }
  if (
    /\b(?:can you|could you|please)\b/.test(normalized) &&
    /\b(?:run|execute|open|search|look up|lookup|write|edit|create|delete|install|navigate|login|sign in)\b/.test(
      normalized,
    )
  ) {
    return false;
  }
  if (
    /\b(?:run|execute|open|search|look up|lookup|write|edit|create|delete|install|navigate|go to|goto|login|sign in|buy|order)\b/.test(
      normalized,
    )
  ) {
    return false;
  }
  if (SMALL_TALK_MESSAGES.has(normalized)) {
    return true;
  }
  return SMALL_TALK_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function detectIdentityIntent(message: string): IdentityIntent {
  const normalized = normalizeSimpleMessage(message);
  if (!normalized) {
    return { askAssistant: false, askUser: false };
  }
  const askAssistant =
    /\bwho are you\b/.test(normalized) ||
    /\bwho you are\b/.test(normalized) ||
    /\bwhat(?:s| is) your name\b/.test(normalized) ||
    /\byour identity\b/.test(normalized) ||
    /\bdo you know (?:who|what) you\b/.test(normalized);
  const askUser =
    /\bwho am i\b/.test(normalized) ||
    /\bwho i am\b/.test(normalized) ||
    /\bwhat(?:s| is) my name\b/.test(normalized) ||
    /\bmy identity\b/.test(normalized) ||
    /\bdo you know (?:who|what) i\b/.test(normalized);
  return { askAssistant, askUser };
}

function parseAssistantNameFromSoul(content: string): string | null {
  const text = String(content ?? "");
  const fromNamedAssistant = /\b(?:assistant|ai assistant)\s+named\s+([A-Za-z0-9_-]{2,64})\b/i.exec(text);
  if (fromNamedAssistant?.[1]) {
    return fromNamedAssistant[1];
  }
  const fromPretendNamed = /\bpretend you are\s+(?:an?|the)\s+ai assistant\s+named\s+([A-Za-z0-9_-]{2,64})\b/i.exec(text);
  if (fromPretendNamed?.[1]) {
    return fromPretendNamed[1];
  }
  const fromIdentity = /##\s*Identity[\s\S]{0,260}?You are\s+([A-Za-z0-9_-]+)/im.exec(text);
  if (fromIdentity?.[1] && !["a", "an", "the", "ai", "assistant"].includes(fromIdentity[1].toLowerCase())) {
    return fromIdentity[1];
  }
  const sentenceMatches = text.matchAll(/\bYou are\s+([A-Za-z0-9_-]+)/gi);
  for (const match of sentenceMatches) {
    const candidate = String(match[1] ?? "").trim();
    if (!candidate) {
      continue;
    }
    if (["a", "an", "the", "ai", "assistant"].includes(candidate.toLowerCase())) {
      continue;
    }
    return candidate;
  }
  return null;
}

function parseUserNameFromUserProfile(content: string): string | null {
  const text = String(content ?? "");
  const fromLine = /^Name:\s*([^\n\r]{1,80})$/im.exec(text);
  if (fromLine?.[1]) {
    return fromLine[1].trim();
  }
  const fromSentence = /\bI am\s+([A-Z][A-Za-z0-9_-]{1,40})\b/i.exec(text);
  if (fromSentence?.[1]) {
    return fromSentence[1].trim();
  }
  return null;
}

function buildIdentityAnchors(soulContent: string, userContent: string): IdentityAnchors {
  return {
    assistantName: parseAssistantNameFromSoul(soulContent),
    userName: parseUserNameFromUserProfile(userContent),
  };
}

export function isIdentityAnswerGrounded(
  answer: string,
  anchors: IdentityAnchors,
  intent: IdentityIntent,
): boolean {
  const text = String(answer ?? "").toLowerCase();
  if (!text) {
    return false;
  }
  const assistantName = String(anchors.assistantName ?? "").toLowerCase();
  const userName = String(anchors.userName ?? "").toLowerCase();
  const mentionsAssistant = assistantName ? text.includes(assistantName) : false;
  const mentionsUser = userName ? text.includes(userName) : false;

  if (intent.askAssistant && assistantName && !mentionsAssistant) {
    return false;
  }
  if (intent.askUser && userName && !mentionsUser) {
    return false;
  }
  if (intent.askAssistant && !intent.askUser && userName && mentionsUser) {
    return false;
  }
  if (intent.askUser && !intent.askAssistant && assistantName && mentionsAssistant) {
    return false;
  }

  return intent.askAssistant || intent.askUser ? true : mentionsAssistant || mentionsUser;
}

function buildIdentityGroundingInstruction(intent: IdentityIntent, anchors: IdentityAnchors): string {
  const hints: string[] = [];
  if (anchors.assistantName) {
    hints.push(`assistant identity from SOUL.md: ${anchors.assistantName}`);
  }
  if (anchors.userName) {
    hints.push(`user identity from USER.md: ${anchors.userName}`);
  }
  const hintText = hints.length > 0 ? ` Use these anchors: ${hints.join("; ")}.` : "";
  if (intent.askAssistant && !intent.askUser) {
    return "System instruction: answer the user's assistant-identity question naturally using SOUL.md identity content. Do not invent a different assistant name." + hintText;
  }
  if (intent.askUser && !intent.askAssistant) {
    return "System instruction: answer the user's self-identity question naturally using USER.md identity content. Do not invent a different user name." + hintText;
  }
  return "System instruction: answer both assistant and user identity naturally using SOUL.md and USER.md identity content. Do not invent different names." + hintText;
}

function stripIdentityReasoningLeak(answer: string): string {
  const raw = String(answer ?? "").trim();
  if (!raw) {
    return raw;
  }
  const paragraphs = raw.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length < 2) {
    return raw;
  }
  const looksLikeLeak = (text: string): boolean => {
    const normalized = text.toLowerCase();
    return (
      normalized.startsWith("okay, the user") ||
      normalized.startsWith("the user is asking") ||
      normalized.includes("let me think") ||
      normalized.includes("i need to") ||
      normalized.includes("i should") ||
      normalized.includes("system instruction")
    );
  };
  let index = 0;
  while (index < paragraphs.length && looksLikeLeak(paragraphs[index])) {
    index += 1;
  }
  if (index <= 0 || index >= paragraphs.length) {
    return raw;
  }
  return paragraphs.slice(index).join("\n\n");
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
  const runtimeResolution = resolveRuntimeProvider({
    routeProviderId: provider,
    profile,
  });
  const rawBaseUrl = normalizeBaseUrl(profile.baseUrl) ?? normalizeBaseUrl(runtimeResolution.baseUrlOverride);
  const normalizedBaseUrl =
    runtimeResolution.runtimeProvider === OPENAI_RUNTIME_PROVIDER
      ? normalizeOpenAICompatibleBaseUrl(rawBaseUrl)
      : rawBaseUrl;
  const routeProviderId = String(provider).trim().toLowerCase();
  const profileProviderId = String(profile.provider ?? "").trim().toLowerCase();
  const allowMissingCredential = Boolean(
    normalizedBaseUrl &&
      runtimeResolution.runtimeProvider === OPENAI_RUNTIME_PROVIDER &&
      (routeProviderId === "local-openai" || profileProviderId === "openai"),
  );
  if (!credential && !allowMissingCredential) {
    throw new Error(`Credentials missing for provider '${provider}'.`);
  }
  const requestApiKey = credential ?? (allowMissingCredential ? LOCAL_OPENAI_DUMMY_API_KEY : undefined);

  const typedProvider = runtimeResolution.runtimeProvider;
  const runtimeProfile: ProviderProfile =
    normalizedBaseUrl && normalizeBaseUrl(profile.baseUrl) !== normalizedBaseUrl
      ? { ...profile, baseUrl: normalizedBaseUrl }
      : profile;

  const sessionId = params.sessionId || params.externalUserId || "default";
  const history = await loadSessionMessages(sessionId);
  let pendingMfa = pendingMfaBySession.get(sessionId);
  const pendingServiceHint = pendingMfa?.service ?? null;
  const oneTimeCode = extractLikelyOneTimeCode(params.message);
  const mfaRecoveryIntent =
    pendingMfa && !oneTimeCode ? looksLikeMfaRecoveryIntent(params.message) : false;
  if (
    pendingMfa &&
    !oneTimeCode &&
    (looksLikeLoginIntent(params.message) || looksLikeSiteVisitIntent(params.message) || mfaRecoveryIntent)
  ) {
    pendingMfaBySession.delete(sessionId);
    pendingMfa = undefined;
  }
  if (
    pendingMfa &&
    !oneTimeCode &&
    messageLikelyAsksToContinueWithoutCode(params.message) &&
    !looksLikeLoginIntent(params.message) &&
    !looksLikeSiteVisitIntent(params.message)
  ) {
    return {
      message:
        "I’m paused at MFA. Send the one-time code (4-10 digits) and I’ll enter it immediately.",
      thinking: null,
      toolCalls: [],
      provider,
      model,
    };
  }
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
  const smallTalkTurn = isSmallTalkMessage(params.message);

  let discoveredLocalModels: string[] = [];
  let resolvedModelId = resolveModelAlias({
    runtimeProvider: typedProvider,
    requestedProvider: runtimeResolution.requestedProvider,
    modelId: model,
  });
  if (routeProviderId === "local-openai" && normalizedBaseUrl) {
    discoveredLocalModels = await discoverLocalOpenAIModels({
      baseUrl: normalizedBaseUrl,
      apiKey: requestApiKey,
      headers: runtimeProfile.headers,
    });
    resolvedModelId = remapModelIdFromAvailable(resolvedModelId, discoveredLocalModels);
  }
  const discovered = getModel(typedProvider, resolvedModelId as never);
  let modelDef = discovered
    ? applyProfileModelOverrides({
        provider: typedProvider,
        profile: runtimeProfile,
        modelDef: discovered,
      })
    : undefined;

  if (!modelDef) {
    modelDef = buildCustomModelDefinition({
      provider: typedProvider,
      profile: runtimeProfile,
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

  const compactMode = isCompactModeEnabled({
    routeProviderId,
    baseUrl: normalizedBaseUrl,
  });
  const emailToolAllowed =
    process.env.T560_ENABLE_EMAIL_TOOL_ALWAYS === "1" ||
    messageLikelyNeedsEmailTool(params.message) ||
    looksLikeLoginIntent(params.message) ||
    looksLikeAccountDashboardIntent(params.message) ||
    Boolean(pendingMfa);
  const baseTools = smallTalkTurn
    ? []
    : createT560CodingTools({
        workspaceDir: process.cwd(),
        config: params.config,
        modelProvider: typedProvider,
        senderIsOwner: true
      }).filter((tool) => emailToolAllowed || String(tool.name ?? "").toLowerCase() !== "email");
  const tools =
    compactMode && !smallTalkTurn
      ? selectToolsForCompactMode(baseTools, params.message, Boolean(pendingMfa))
      : baseTools;
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
    config: params.config,
    compactMode,
    toolNames: tools.map((tool) => tool.name),
  });
  const injectedContextFiles = buildInjectedIdentityContextFiles({
    soulPath: soulPrompt.path,
    soulContent: soulPrompt.content,
    userPath: usersPrompt.path,
    userContent: usersPrompt.content,
  });
  assertIdentityContextFilesInjected(injectedContextFiles);
  const toolSkillReminders = await resolveToolSkillRemindersForRun({
    workspaceDir: process.cwd(),
    compactMode,
    toolNames: tools.map((tool) => tool.name),
  });
  assertToolSkillCoverage(tools.map((tool) => tool.name), toolSkillReminders);

  const systemPrompt = buildAgentSystemPrompt({
    workspaceDir: process.cwd(),
    skillsPrompt,
    injectedContextFiles,
    toolNames: tools.map((tool) => tool.name),
    compactMode,
  });
  assertSystemPromptHasIdentityFiles(systemPrompt);
  assertSystemPromptHasIdentityContent({
    systemPrompt,
    soulContent: soulPrompt.content,
    userContent: usersPrompt.content,
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

  const historyForRun = compactMode
    ? history.slice(Math.max(0, history.length - resolveCompactHistoryMessages()))
    : history;
  const messages: Message[] = [...historyForRun, userMessage];
  const identityIntent = detectIdentityIntent(params.message);
  const identityQuestion = identityIntent.askAssistant || identityIntent.askUser;
  const injectedSoulContent =
    injectedContextFiles.find((file) => String(file.name ?? "").trim().toUpperCase() === "SOUL.MD" && !file.missing)
      ?.content ?? soulPrompt.content;
  const injectedUserContent =
    injectedContextFiles.find((file) => String(file.name ?? "").trim().toUpperCase() === "USER.MD" && !file.missing)
      ?.content ?? usersPrompt.content;
  const identityAnchors = buildIdentityAnchors(injectedSoulContent, injectedUserContent);
  let identityRetryCount = 0;
  let savedServiceFromMessage: string | null = null;
  const autoAuthIntent =
    looksLikeLoginIntent(params.message) ||
    looksLikeAccountDashboardIntent(params.message) ||
    looksLikeSiteVisitIntent(params.message) ||
    mfaRecoveryIntent;
  if (
    !pendingMfa &&
    autoAuthIntent
  ) {
    if (mfaRecoveryIntent && pendingServiceHint) {
      savedServiceFromMessage = normalizeSetupService(pendingServiceHint) ?? pendingServiceHint;
    }
    try {
      if (!savedServiceFromMessage) {
        const savedService = await resolveSavedServiceFromUserMessage({
          workspaceDir: process.cwd(),
          message: params.message,
        });
        savedServiceFromMessage = savedService;
      }
    } catch {
      // best effort bootstrap; continue without it if lookup fails
    }
  }
  const allToolCalls: string[] = [];
  const toolOutcomes: Array<{
    toolName: string;
    isError: boolean;
    content: string;
  }> = [];
  let completionVerificationNeeded = requestLikelyNeedsCompletionVerification(params.message);
  let completionVerificationSatisfied = !completionVerificationNeeded;
  let completionVerificationPromptSent = false;
  const registerCompletionVerificationSignal = (params: {
    toolName: string;
    args: Record<string, unknown>;
    isError: boolean;
  }) => {
    if (params.isError) {
      return;
    }
    const normalizedToolName = String(params.toolName ?? "").trim().toLowerCase();
    if (!normalizedToolName) {
      return;
    }
    if (toolCallMutatesState(normalizedToolName, params.args)) {
      completionVerificationNeeded = true;
      completionVerificationSatisfied = false;
      completionVerificationPromptSent = false;
    }
    if (completionVerificationNeeded && toolCallVerifiesState(normalizedToolName, params.args)) {
      completionVerificationSatisfied = true;
    }
  };
  let latestBrowserLoginState: {
    submitted: boolean;
    requiresMfa: boolean;
    mfaExpected: boolean;
    identifier: string | null;
  } | null = null;
  let recoveryPromptSent = false;
  let finalizationPromptSent = false;
  let emptyReplyRecoveryPromptSent = false;
  let forceWaitForMfaCode = false;
  let lastAssistant: AssistantMessage | undefined;
  let checkoutBlockedMessage: string | null = null;
  let compactGuardrailMessage: string | null = null;
  let compactFailureStreak = 0;
  const challengeScreenshotKeys = new Set<string>();
  const forceToolUse =
    !smallTalkTurn &&
    (requestLikelyNeedsTools(params.message) || Boolean(pendingMfa && oneTimeCode));
  const maxToolRounds = compactMode ? COMPACT_MODE_MAX_TOOL_ROUNDS : MAX_TOOL_ROUNDS;
  const toolResultContextMaxChars = resolveToolResultContextMaxChars(compactMode);
  const providerTimeoutMs = resolveProviderTimeoutMs({
    routeProviderId,
    baseUrl: normalizedBaseUrl,
  });
  const toolExecutionTimeoutMs = resolveToolExecutionTimeoutMs();
  const timedOutToolCallIds = new Set<string>();
  let providerAttempt = 0;
  const modelBaseUrl =
    typeof (modelDef as { baseUrl?: unknown }).baseUrl === "string"
      ? (modelDef as { baseUrl: string }).baseUrl
      : "";
  const requestAssistant = async (context: Context): Promise<AssistantMessage> => {
    assertSystemPromptHasIdentityFiles(String(context.systemPrompt ?? ""));
    providerAttempt += 1;
    await appendPromptTraceRecord({
      type: "provider_prompt_context",
      timestamp: new Date().toISOString(),
      sessionId,
      channel: params.channel,
      provider: typedProvider,
      model: resolvedModelId,
      attempt: providerAttempt,
      compactMode,
      forceToolUse,
      identityIntent,
      context,
    });
    const abortController = new AbortController();
    const endpointHint = modelBaseUrl ? ` endpoint=${modelBaseUrl}` : "";
    const timeoutMessage =
      `Provider request timed out after ${Math.round(providerTimeoutMs / 1000)}s.${endpointHint}`;
    try {
      return await runWithHardTimeout({
        operation: complete(modelDef, context, {
          ...(requestApiKey ? { apiKey: requestApiKey } : {}),
          ...(profile.headers && Object.keys(profile.headers).length > 0
            ? { headers: profile.headers }
            : {}),
          sessionId,
          signal: abortController.signal,
          metadata: {
            channel: params.channel,
            userId: params.externalUserId
          }
        }),
        timeoutMs: providerTimeoutMs,
        timeoutMessage,
        onTimeout: () => {
          abortController.abort();
        },
      });
    } catch (error: unknown) {
      if (abortController.signal.aborted) {
        throw new Error(timeoutMessage);
      }
      throw error;
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

  let syntheticToolCounter = 0;
  const runSyntheticToolCall = async (toolName: string, argumentsRecord: Record<string, unknown>) => {
    const toolCall = {
      id: `auto-${Date.now()}-${syntheticToolCounter}`,
      name: toolName,
      arguments: argumentsRecord,
    } as unknown as ToolCall;
    syntheticToolCounter += 1;
    const argsProgress = summarizeArgsForProgress(String(toolName ?? "").trim().toLowerCase(), argumentsRecord);
    if (argsProgress) {
      emitAssistantProgress(argsProgress, "pretool");
    }
    let outcome: { isError: boolean; content: string };
    try {
      outcome = await runWithHardTimeout({
        operation: executeToolCall({
          tools,
          toolDefinitions,
          toolCall,
          context: {
            sessionId,
            channel: params.channel,
            provider: typedProvider,
            model: resolvedModelId,
          },
          eventHooks: {
            onStart: ({ toolCallId, toolName: startedTool, args }) => {
              handleToolExecutionStart({
                sessionId,
                channel: params.channel,
                toolCallId,
                toolName: startedTool,
                args,
              });
            },
            onUpdate: ({ toolCallId, toolName: updatedTool, partialResult }) => {
              if (timedOutToolCallIds.has(toolCallId)) {
                return;
              }
              handleToolExecutionUpdate({
                sessionId,
                channel: params.channel,
                toolCallId,
                toolName: updatedTool,
                partialResult,
              });
            },
            onEnd: ({ toolCallId, toolName: endedTool, result, isError, error }) => {
              if (timedOutToolCallIds.has(toolCallId)) {
                return;
              }
              handleToolExecutionEnd({
                sessionId,
                channel: params.channel,
                toolCallId,
                toolName: endedTool,
                result,
                ...(isError ? { error: error ?? "tool execution failed" } : {}),
              });
            },
          },
        }),
        timeoutMs: toolExecutionTimeoutMs,
        timeoutMessage: `Tool '${toolName}' timed out after ${Math.round(toolExecutionTimeoutMs / 1000)}s.`,
      });
    } catch (error: unknown) {
      timedOutToolCallIds.add(toolCall.id);
      const toolError = error instanceof Error ? error.message : String(error);
      handleToolExecutionEnd({
        sessionId,
        channel: params.channel,
        toolCallId: toolCall.id,
        toolName,
        result: toolError,
        error: toolError,
      });
      outcome = {
        isError: true,
        content: toolError,
      };
    }

    allToolCalls.push(toolName);
    toolOutcomes.push({
      toolName,
      isError: outcome.isError,
      content: outcome.content,
    });
    registerCompletionVerificationSignal({
      toolName,
      args: argumentsRecord,
      isError: outcome.isError,
    });
    const progressFromOutcome = summarizeOutcomeForProgress({
      toolName: String(toolName ?? "").trim().toLowerCase(),
      content: outcome.content,
      isError: outcome.isError,
    });
    if (progressFromOutcome) {
      emitAssistantProgress(progressFromOutcome, "progress");
    }
    const normalizedToolName = String(toolName ?? "").trim().toLowerCase();
    if (normalizedToolName === "browser") {
      updatePendingMfaStateFromBrowserTool({
        sessionId,
        toolArgs: argumentsRecord,
        outcomeContent: outcome.content,
        isError: outcome.isError,
      });
      await maybeCaptureCaptchaScreenshotForTelegram(argumentsRecord, outcome);
      const action = String(argumentsRecord.action ?? "")
        .trim()
        .toLowerCase();
      if (!outcome.isError && action === "login") {
        const parsedLoginState = parseBrowserLoginState(outcome.content);
        if (parsedLoginState) {
          latestBrowserLoginState = parsedLoginState;
        }
      }
    }
    return {
      toolCall,
      outcome,
    };
  };

  async function maybeCaptureCaptchaScreenshotForTelegram(
    toolArgs: unknown,
    outcome: { isError: boolean; content: string },
  ): Promise<void> {
    if (params.channel !== "telegram") {
      return;
    }
    const args = toolArgs && typeof toolArgs === "object" ? (toolArgs as Record<string, unknown>) : {};
    const action = normalizeBrowserActionName(args.action);
    const challengeState = parseBrowserChallengeState(outcome.content);
    const looksLikeChallengeError =
      outcome.isError &&
      (action === "login" || action === "challenge" || action === "open" || action === "click" || action === "act") &&
      outcomeLooksLikeHumanVerificationError(outcome.content);
    if (!challengeState.detected && !looksLikeChallengeError) {
      return;
    }
    const tabIdRaw = String(args.tabId ?? challengeState.tabId ?? "").trim();
    const key = tabIdRaw ? `tab:${tabIdRaw}` : "tab:active";
    if (challengeScreenshotKeys.has(key)) {
      return;
    }
    challengeScreenshotKeys.add(key);
    await runSyntheticToolCall("browser", {
      action: "screenshot",
      ...(tabIdRaw ? { tabId: tabIdRaw } : {}),
      engine: "live",
      allowEngineFallback: true,
      reason: "captcha_challenge",
    });
  }

  let autoAuthLoginSucceeded = false;
  if (!pendingMfa && savedServiceFromMessage && autoAuthIntent) {
    const targetUrl = extractTargetUrlFromMessage(params.message) || inferTargetUrlFromService(savedServiceFromMessage);
    if (targetUrl) {
      await runSyntheticToolCall("browser", {
        action: "open",
        url: targetUrl,
        engine: "live",
        allowEngineFallback: true,
      });
    }
    const loginRun = await runSyntheticToolCall("browser", {
      action: "login",
      service: savedServiceFromMessage,
      engine: "live",
      allowEngineFallback: true,
    });
    if (!loginRun.outcome.isError) {
      autoAuthLoginSucceeded = true;
      const autoLoginState = parseBrowserLoginState(loginRun.outcome.content);
      if (autoLoginState) {
        latestBrowserLoginState = autoLoginState;
      }
      const mfaState = parseBrowserMfaState(loginRun.outcome.content);
      if (mfaState.requiresMfa) {
        let resolvedCode: string | null = null;
        const pendingAfterLogin = pendingMfaBySession.get(sessionId);
        if (mfaState.mfaSourceCredentialAvailable && mfaState.mfaSourceService && hasTool(tools, "email")) {
          for (const action of ["list_unread", "read_recent"] as const) {
            const emailRun = await runSyntheticToolCall("email", {
              action,
              service: mfaState.mfaSourceService,
              limit: 8,
              includeBody: true,
              markSeen: false,
            });
            if (emailRun.outcome.isError) {
              continue;
            }
            const candidate = extractLikelyOneTimeCodeFromEmailOutcome(emailRun.outcome.content);
            if (candidate) {
              resolvedCode = candidate;
              break;
            }
          }
        }
        if (resolvedCode) {
          await runSyntheticToolCall("browser", {
            action: "mfa",
            code: resolvedCode,
            ...(pendingAfterLogin?.tabId ? { tabId: pendingAfterLogin.tabId } : {}),
            ...(pendingAfterLogin?.service ? { service: pendingAfterLogin.service } : {}),
            engine: "live",
            allowEngineFallback: true,
          });
        }
        if (pendingMfaBySession.has(sessionId)) {
          forceWaitForMfaCode = true;
        }
      }
    }
  }
  if (
    autoAuthLoginSucceeded &&
    latestBrowserLoginState &&
    !latestBrowserLoginState.submitted &&
    latestBrowserLoginState.mfaExpected
  ) {
    messages.push({
      role: "user",
      content: [
        "System instruction: vault login filled the identifier but code request is not confirmed as submitted yet.",
        "Continue in browser on current tab and trigger the non-social email/code submit action.",
        "Do not ask for credentials; ask only for one-time code after submission is confirmed.",
      ].join(" "),
      timestamp: Date.now(),
    });
  }
  if (autoAuthLoginSucceeded && !forceWaitForMfaCode) {
    messages.push({
      role: "user",
      content: [
        "System instruction: Automatic vault-backed browser login steps have already run in runtime for this request.",
        "Continue from the current browser tab/session and do not ask the user for credentials.",
        "If MFA is encountered, request only the one-time code or use configured mailbox retrieval.",
      ].join(" "),
      timestamp: Date.now(),
    });
  }

  beginCheckoutWorkflowTurn({
    sessionId,
    userMessage: params.message,
  });

  for (let round = 0; round < maxToolRounds && !forceWaitForMfaCode; round++) {
    let roundProgressCount = 0;
    const emitRoundProgress = (text: string, phase: "pretool" | "progress" = "progress") => {
      if (roundProgressCount >= LIVE_PROGRESS_LINES_PER_ROUND) {
        return;
      }
      const trimmed = clipProgressText(cleanProgressLine(text));
      if (!trimmed) {
        return;
      }
      if (isGenericProgressLine(trimmed)) {
        return;
      }
      emitAssistantProgress(trimmed, phase);
      roundProgressCount += 1;
    };
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
    const roundFlattened = flattenAssistantMessage(assistant);
    if (toolCalls.length > 0 && roundFlattened.text) {
      const assistantProgress = selectAssistantProgressText(roundFlattened.text);
      if (assistantProgress) {
        emitRoundProgress(assistantProgress, round === 0 ? "pretool" : "progress");
      }
    }

    if (toolCalls.length === 0) {
      if (
        identityQuestion &&
        identityRetryCount < 2 &&
        !isIdentityAnswerGrounded(roundFlattened.text, identityAnchors, identityIntent)
      ) {
        identityRetryCount += 1;
        messages.push({
          role: "user",
          content: buildIdentityGroundingInstruction(identityIntent, identityAnchors),
          timestamp: Date.now(),
        });
        continue;
      }
      if (
        (looksLikeLoginIntent(params.message) ||
          looksLikeAccountDashboardIntent(params.message) ||
          looksLikeSiteVisitIntent(params.message)) &&
        assistantIsAskingForIdentifier(roundFlattened.text)
      ) {
        let savedService = savedServiceFromMessage;
        if (!savedService && allToolCalls.length > 0) {
          savedService = await resolveSavedServiceFromBrowserOutcomes({
            workspaceDir: process.cwd(),
            toolOutcomes,
          });
        }
        if (savedService) {
          messages.push({
            role: "user",
            content: [
              "System instruction: secure credentials already exist for the current site.",
              `Do not ask the user for email, username, or password.`,
              `Immediately call browser action=\"login\" with service=\"${savedService}\" on the current tab and fill identifier from vault.`,
              "If MFA is required, ask only for the one-time code.",
            ].join(" "),
            timestamp: Date.now()
          });
          continue;
        }
      }
      if (!completionVerificationSatisfied && !completionVerificationPromptSent) {
        completionVerificationPromptSent = true;
        messages.push({
          role: "user",
          content: buildCompletionVerificationInstruction(),
          timestamp: Date.now(),
        });
        continue;
      }
      if (!roundFlattened.text && !emptyReplyRecoveryPromptSent) {
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
          toolOutcomes,
          mfaPending: pendingMfaBySession.has(sessionId),
        })
      ) {
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
      const normalizedToolName = String(toolCall.name ?? "").trim().toLowerCase();
      const argsProgress = summarizeArgsForProgress(
        normalizedToolName,
        toolCall.arguments,
      );
      if (argsProgress) {
        emitRoundProgress(argsProgress, round === 0 ? "pretool" : "progress");
      }
      allToolCalls.push(toolCall.name);
      let outcome: { isError: boolean; content: string };
      const checkoutToolArgs = enrichCheckoutArgsWithPageContext({
        toolName: toolCall.name,
        toolArgs: toolCall.arguments,
        toolOutcomes,
      });
      const checkoutDecision = enforceCheckoutWorkflow({
        sessionId,
        toolName: toolCall.name,
        toolArgs: checkoutToolArgs,
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
        try {
          outcome = await runWithHardTimeout({
            operation: executeToolCall({
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
                  if (timedOutToolCallIds.has(toolCallId)) {
                    return;
                  }
                  handleToolExecutionUpdate({
                    sessionId,
                    channel: params.channel,
                    toolCallId,
                    toolName,
                    partialResult,
                  });
                },
                onEnd: ({ toolCallId, toolName, result, isError, error }) => {
                  if (timedOutToolCallIds.has(toolCallId)) {
                    return;
                  }
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
            }),
            timeoutMs: toolExecutionTimeoutMs,
            timeoutMessage: `Tool '${String(toolCall.name ?? "tool")}' timed out after ${Math.round(toolExecutionTimeoutMs / 1000)}s.`,
          });
        } catch (error: unknown) {
          timedOutToolCallIds.add(toolCall.id);
          const toolError = error instanceof Error ? error.message : String(error);
          handleToolExecutionEnd({
            sessionId,
            channel: params.channel,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            result: toolError,
            error: toolError,
          });
          outcome = {
            isError: true,
            content: toolError,
          };
        }
      }
      toolOutcomes.push({
        toolName: toolCall.name,
        isError: outcome.isError,
        content: outcome.content
      });
      registerCompletionVerificationSignal({
        toolName: toolCall.name,
        args: toToolArgsRecord(toolCall.arguments),
        isError: outcome.isError,
      });
      const progressFromOutcome = summarizeOutcomeForProgress({
        toolName: normalizedToolName,
        content: outcome.content,
        isError: outcome.isError,
      });
      if (progressFromOutcome) {
        emitRoundProgress(progressFromOutcome);
      }
      if (normalizedToolName === "browser") {
        updatePendingMfaStateFromBrowserTool({
          sessionId,
          toolArgs: toolCall.arguments,
          outcomeContent: outcome.content,
          isError: outcome.isError,
        });
        await maybeCaptureCaptchaScreenshotForTelegram(toolCall.arguments, outcome);
        const action = String(
          toolCall.arguments && typeof toolCall.arguments === "object"
            ? (toolCall.arguments as Record<string, unknown>).action ?? ""
            : "",
        )
          .trim()
          .toLowerCase();
        if (!outcome.isError && action === "login") {
          const parsedLoginState = parseBrowserLoginState(outcome.content);
          if (parsedLoginState) {
            latestBrowserLoginState = parsedLoginState;
          }
          const mfaState = parseBrowserMfaState(outcome.content);
          if (mfaState.requiresMfa) {
            const pendingNow = pendingMfaBySession.get(sessionId);
            if (
              mfaState.mfaSourceCredentialAvailable &&
              mfaState.mfaSourceService &&
              hasTool(tools, "email")
            ) {
              messages.push({
                role: "user",
                content: buildAutoMfaFromEmailInstruction({
                  sourceService: mfaState.mfaSourceService,
                  pending: pendingNow,
                }),
                timestamp: Date.now(),
              });
            } else {
              forceWaitForMfaCode = true;
            }
            break;
          }
        }
      }

      messages.push({
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [
          {
            type: "text",
            text: clampTextForModelContext(outcome.content, toolResultContextMaxChars),
          },
        ],
        isError: outcome.isError,
        timestamp: Date.now()
      });
      const toolReminder = toolSkillReminders[normalizedToolName];
      if (toolReminder) {
        messages.push({
          role: "user",
          content: [
            `System instruction: tool "${normalizedToolName}" was just used.`,
            "Continue by following this tool-specific guidance:",
            toolReminder,
          ].join("\n"),
          timestamp: Date.now(),
        });
      }
      if (compactMode) {
        compactFailureStreak = outcome.isError ? compactFailureStreak + 1 : 0;
        if (compactFailureStreak >= 3) {
          compactGuardrailMessage =
            "I stopped after repeated tool failures to protect the local runtime. Tell me one narrower next step and I will continue.";
          break;
        }
      }
      if (checkoutBlockedMessage) {
        break;
      }
    }
    if (forceWaitForMfaCode) {
      break;
    }
    if (checkoutBlockedMessage) {
      break;
    }
    if (compactGuardrailMessage) {
      break;
    }
  }

  if (
    !forceWaitForMfaCode &&
    autoAuthLoginSucceeded &&
    latestBrowserLoginState?.mfaExpected &&
    !latestBrowserLoginState.submitted
  ) {
    let retryService = savedServiceFromMessage;
    if (!retryService) {
      retryService = await resolveSavedServiceFromBrowserOutcomes({
        workspaceDir: process.cwd(),
        toolOutcomes,
      });
    }
    if (retryService) {
      const retryLoginRun = await runSyntheticToolCall("browser", {
        action: "login",
        service: retryService,
        engine: "live",
        allowEngineFallback: true,
      });
      if (!retryLoginRun.outcome.isError) {
        const retryLoginState = parseBrowserLoginState(retryLoginRun.outcome.content);
        if (retryLoginState) {
          latestBrowserLoginState = retryLoginState;
        }
        const retryMfaState = parseBrowserMfaState(retryLoginRun.outcome.content);
        if (retryMfaState.requiresMfa && pendingMfaBySession.has(sessionId)) {
          forceWaitForMfaCode = true;
        }
      }
    }
  }

  if (!lastAssistant) {
    if (forceWaitForMfaCode) {
      lastAssistant = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        timestamp: Date.now(),
      } as AssistantMessage;
    } else {
      throw new Error("Provider did not return an assistant response.");
    }
  }

  if (!forceWaitForMfaCode && allToolCalls.length > 0 && !flattenAssistantMessage(lastAssistant).text) {
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
          .map((entry) => `- ${summarizeToolContent(entry.content)}`)
          .join("\n")
      : "";
  const successSummary =
    successfulToolOutcomes.length > 0
      ? `Verified steps completed: ${successfulToolOutcomes.length}`
      : "";
  let message = flattened.text || "";
  if (identityQuestion) {
    message = stripIdentityReasoningLeak(message);
  }
  const assistantStopReason = String((lastAssistant as { stopReason?: unknown }).stopReason ?? "")
    .trim()
    .toLowerCase();
  const assistantErrored = assistantStopReason === "error" || assistantStopReason === "aborted";
  const assistantErrorMessage = String((lastAssistant as { errorMessage?: unknown }).errorMessage ?? "").trim();
  if (forceWaitForMfaCode) {
    if (latestBrowserLoginState?.submitted) {
      if (latestBrowserLoginState.identifier) {
        message = `I filled the saved sign-in email (${latestBrowserLoginState.identifier}) and sent the one-time code request. Send me the code and I will enter it immediately.`;
      } else {
        message =
          "I used your saved vault credentials and sent the one-time code request. Send me the code and I will enter it immediately.";
      }
    } else if (latestBrowserLoginState?.identifier) {
      message = `I filled the saved sign-in email (${latestBrowserLoginState.identifier}) and reached the one-time code step. Send me the code and I will enter it immediately.`;
    } else {
      message = "I reached the one-time code step with saved credentials. Send me the code and I will enter it immediately.";
    }
  }

  if (
    !forceWaitForMfaCode &&
    latestBrowserLoginState?.mfaExpected &&
    assistantRefusedOtpRelay(message) &&
    (looksLikeLoginIntent(params.message) ||
      looksLikeAccountDashboardIntent(params.message) ||
      looksLikeSiteVisitIntent(params.message))
  ) {
    if (latestBrowserLoginState.submitted) {
      message = latestBrowserLoginState.identifier
        ? `I filled ${latestBrowserLoginState.identifier} and sent the one-time code request. Send me the code and I will enter it immediately.`
        : "I sent the one-time code request. Send me the code and I will enter it immediately.";
    } else {
      message = latestBrowserLoginState.identifier
        ? `I filled ${latestBrowserLoginState.identifier}, but the send-code click is not confirmed yet. Tell me to retry and I will trigger it again.`
        : "The send-code click is not confirmed yet. Tell me to retry and I will trigger it again.";
    }
  }

  if (!forceWaitForMfaCode && !flattened.text && allToolCalls.length > 0) {
    message = buildToolOnlyFallbackMessage({
      userMessage: params.message,
      successfulToolOutcomes,
      failedToolOutcomes,
    });
  }

  if (forceToolUse && allToolCalls.length === 0 && (assistantErrored || !message.trim())) {
    message = [
      "I could not complete this action because no verification steps were completed.",
      "I will only claim completion after direct verification confirms results."
    ].join("\n");
  }

  if (!message.trim() && assistantErrored && assistantErrorMessage) {
    message = formatProviderRuntimeFailure({
      provider,
      model: resolvedModelId,
      endpoint: modelBaseUrl || undefined,
      rawError: assistantErrorMessage,
      availableModels: discoveredLocalModels,
    });
  }

  if (!message.trim()) {
    message = allToolCalls.length > 0
      ? [
          "I completed verification but did not receive a final textual summary from the model.",
          successSummary || null,
        ]
          .filter(Boolean)
          .join("\n")
      : "I could not generate a non-empty response for this request. Please retry and I will continue from the current session state.";
  }

  if (!forceWaitForMfaCode && completionVerificationNeeded && !completionVerificationSatisfied) {
    message = [
      "I cannot claim this task is complete yet.",
      "A state-changing step ran, but a direct post-action verification step has not completed successfully.",
      "Tell me to continue and I will run verification before finalizing."
    ].join("\n");
  }

  if (failedToolOutcomes.length > 0 && successfulToolOutcomes.length === 0) {
    const lines = [
      "I completed this request with verification failures, so you should not trust any unstated success claims.",
      successSummary || "No successful verification steps were confirmed.",
      "Errors:",
      errorSummary
    ];
    message = lines.filter(Boolean).join("\n");
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
  if (compactGuardrailMessage) {
    message = compactGuardrailMessage;
  }

  await maybeAutoSaveMemoryFromUserMessage({
    message: params.message,
    workspaceDir: process.cwd(),
    env: process.env,
    skip: allToolCalls.some((toolName) => {
      const normalized = String(toolName ?? "").trim().toLowerCase();
      return (
        normalized === "memory_save" ||
        normalized === "memory_delete" ||
        normalized === "memory_prune" ||
        normalized === "memory_feedback" ||
        normalized === "memory_compact"
      );
    }),
  });

  return {
    message,
    thinking: flattened.thinking,
    toolCalls: [],
    provider: typedProvider,
    model: resolvedModelId
  };
}
