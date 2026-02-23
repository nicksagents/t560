import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL, fileURLToPath } from "node:url";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import type { ChatResponse } from "../agent/chat-service.js";
import type { AgentEvent } from "../agents/agent-events.js";
import { loadT560BootstrapContext, T560_BOOTSTRAP_FILENAMES } from "../agents/bootstrap-context.js";
import {
  ensureStateDir,
  readConfig,
  readOnboardingStatus,
  resolveConfigPath,
  resolveBootstrapMaxChars,
  resolveLegacyUserPath,
  resolveSoulPath,
  resolveRoutingTarget,
  resolveUsersPath,
  writeConfig,
  type T560Config,
} from "../config/state.js";
import { bustSoulPromptCache, bustUsersPromptCache } from "../provider/run.js";
import { loadSessionMessages, saveSessionMessages } from "../provider/session.js";
import { summarizeSavedUsage } from "../provider/usage-summary.js";
import { isHeartbeatCheckMessage } from "../gateway/heartbeat.js";
import type { GatewayInboundMessage } from "../gateway/types.js";
import { resolveTailscaleStatus } from "../network/tailscale.js";
import { listProviderCatalog } from "../onboarding/provider-catalog.js";
import {
  deleteCredential,
  getCredential,
  listConfiguredServices,
  normalizeSetupService,
  setCredential,
  type CredentialAuthMode,
} from "../security/credentials-vault.js";

export type DashboardServer = {
  port: number;
  url: string;
  localUrl: string;
  tailscaleUrl: string | null;
  bindHost: string;
  close: () => Promise<void>;
};

export type DashboardServerOptions = {
  handleMessage: (input: GatewayInboundMessage) => Promise<ChatResponse>;
  subscribeEvents?: (params: {
    sessionId?: string;
    onEvent: (event: AgentEvent) => void;
  }) => () => void;
};

type ChatRequest = {
  message?: string;
  sessionKey?: string;
};

/* ═══════════════════════════════════════════
   HTTP Helpers
   ═══════════════════════════════════════════ */

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function parsePort(portRaw: string | undefined): number {
  if (!portRaw) return 5600;
  const value = Number(portRaw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) return 5600;
  return value;
}

function parseBindHost(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  return value || "0.0.0.0";
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Dashboard server failed to resolve listening port."));
        return;
      }
      resolve(address.port);
    });
  });
}

async function startListening(server: Server, preferredPort: number, host: string): Promise<number> {
  try {
    return await listen(server, preferredPort, host);
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code !== "EADDRINUSE") throw error;
    return listen(server, 0, host);
  }
}

/* ═══════════════════════════════════════════
   Security Headers
   ═══════════════════════════════════════════ */

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

/* ═══════════════════════════════════════════
   Static File Serving (Vite build output)
   ═══════════════════════════════════════════ */

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

/** Resolve the control-ui build directory */
function resolveUiRoot(): string | null {
  const candidates: string[] = [];

  // Try dist/control-ui relative to the project root
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  candidates.push(
    // From dist/web/dashboard.js -> dist/control-ui
    join(__dirname, "..", "control-ui"),
    // From src/web/dashboard.ts -> ../../dist/control-ui (dev mode)
    join(__dirname, "..", "..", "dist", "control-ui"),
    // Last resort relative to current working directory.
    join(process.cwd(), "dist", "control-ui"),
  );

  for (const root of candidates) {
    if (existsSync(join(root, "index.html"))) {
      return root;
    }
  }

  return null;
}

function resolveProjectRootFromDashboardFile(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const guessed = join(__dirname, "..", "..");
  if (existsSync(join(guessed, "package.json")) && existsSync(join(guessed, "ui", "package.json"))) {
    return guessed;
  }
  return process.cwd();
}

function runCommandSync(cmd: string, args: string[], cwd: string): boolean {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  return result.status === 0;
}

function ensureControlUiBuilt(): { uiRoot: string | null; autoBuilt: boolean } {
  const existing = resolveUiRoot();
  if (existing) {
    return { uiRoot: existing, autoBuilt: false };
  }

  if (process.env.T560_AUTO_BUILD_UI === "0") {
    return { uiRoot: null, autoBuilt: false };
  }

  const projectRoot = resolveProjectRootFromDashboardFile();
  const uiDir = join(projectRoot, "ui");
  if (!existsSync(join(uiDir, "package.json"))) {
    return { uiRoot: null, autoBuilt: false };
  }

  console.warn("[dashboard] Control UI bundle missing; auto-building UI...");
  const hasUiNodeModules = existsSync(join(uiDir, "node_modules"));
  if (!hasUiNodeModules) {
    const installed = runCommandSync("npm", ["install"], uiDir);
    if (!installed) {
      console.warn("[dashboard] UI dependency install failed.");
      return { uiRoot: null, autoBuilt: true };
    }
  }
  const built = runCommandSync("npm", ["run", "build"], uiDir);
  if (!built) {
    console.warn("[dashboard] UI build failed.");
    return { uiRoot: null, autoBuilt: true };
  }
  return { uiRoot: resolveUiRoot(), autoBuilt: true };
}

function serveStaticFile(res: ServerResponse, uiRoot: string, pathname: string): boolean {
  // Normalize path to prevent directory traversal
  const safePath = pathname.replace(/\.\./g, "").replace(/\/+/g, "/").replace(/^\/+/, "");
  let filePath = join(uiRoot, safePath);

  // Check if file exists
  try {
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      filePath = join(filePath, "index.html");
    }
  } catch {
    // File doesn't exist
    return false;
  }

  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;

    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    setSecurityHeaders(res);
    res.statusCode = 200;
    res.setHeader("content-type", contentType);
    res.setHeader("cache-control", "no-cache");
    res.end(readFileSync(filePath));
    return true;
  } catch {
    return false;
  }
}

/* ═══════════════════════════════════════════
   WebSocket Gateway
   ═══════════════════════════════════════════ */

interface WsFrame {
  type: "req" | "res" | "event";
  id?: string;
  method?: string;
  params?: any;
  ok?: boolean;
  payload?: any;
  error?: { code: string; message: string };
  event?: string;
  seq?: number;
}

interface WsClient {
  ws: import("ws").WebSocket;
  id: string;
  sessionKey: string;
  unsubscribeEvents?: () => void;
}

function sendWsFrame(ws: import("ws").WebSocket, frame: WsFrame): void {
  try {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(JSON.stringify(frame));
    }
  } catch {
    // ignore send errors
  }
}

function sendWsResponse(ws: import("ws").WebSocket, id: string, ok: boolean, payload?: any, error?: { code: string; message: string }): void {
  sendWsFrame(ws, { type: "res", id, ok, payload, error });
}

function sendWsEvent(ws: import("ws").WebSocket, event: string, payload?: any): void {
  sendWsFrame(ws, { type: "event", event, payload });
}

function summarizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (!oneLine) {
    return "Unknown error.";
  }
  return oneLine.length > 240 ? `${oneLine.slice(0, 240)}...` : oneLine;
}

function buildFallbackChatResponse(error: unknown): ChatResponse {
  return {
    role: "assistant",
    message: `I hit an internal error while processing that request: ${summarizeErrorMessage(error)}`,
    thinking: null,
    toolCalls: [],
    mode: "provider",
    provider: null,
    model: null,
    onboardingRequired: false,
    missing: [],
  };
}

function toWsAssistantChatPayload(reply: ChatResponse): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    message: reply.message,
    thinking: reply.thinking,
    toolCalls: reply.toolCalls,
    provider: reply.provider,
    model: reply.model,
    timestamp: Date.now(),
  };
}

const BOOTSTRAP_FILE_NAME_SET = new Set<string>(T560_BOOTSTRAP_FILENAMES);

function normalizeHistoryLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 80;
  }
  return Math.max(1, Math.min(200, Math.floor(n)));
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const lines = content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const candidate = block as { text?: unknown; type?: unknown; content?: unknown };
      if (typeof candidate.text === "string") {
        return candidate.text;
      }
      if (candidate.type === "text" && typeof candidate.content === "string") {
        return candidate.content;
      }
      return "";
    })
    .filter(Boolean);
  return lines.join("\n").trim();
}

async function readWebchatHistory(sessionKey: string, limit: number): Promise<Array<Record<string, unknown>>> {
  const sessionId = `webchat:${sessionKey}`;
  const all = await loadSessionMessages(sessionId);
  const filtered = all.filter((entry) => entry?.role === "user" || entry?.role === "assistant");
  const tail = filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered;
  return tail.map((entry) => {
    const role = entry.role === "assistant" ? "assistant" : "user";
    return {
      id: crypto.randomUUID(),
      role,
      message: extractTextContent(entry.content),
      timestamp: typeof entry.timestamp === "number" ? entry.timestamp : Date.now(),
    };
  });
}

function bindClientEvents(client: WsClient, opts: DashboardServerOptions): void {
  client.unsubscribeEvents?.();
  client.unsubscribeEvents = undefined;

  if (!opts.subscribeEvents) {
    return;
  }

  client.unsubscribeEvents = opts.subscribeEvents({
    sessionId: `webchat:${client.sessionKey}`,
    onEvent: (event) => {
      sendWsEvent(client.ws, "agent.event", event);
    }
  });
}

/* ═══════════════════════════════════════════
   API Handlers
   ═══════════════════════════════════════════ */

async function handleStatus(res: ServerResponse): Promise<void> {
  const status = await readOnboardingStatus();
  const defaultRoute = resolveRoutingTarget(status.config, "default");
  const planningRoute = resolveRoutingTarget(status.config, "planning");
  const codingRoute = resolveRoutingTarget(status.config, "coding");
  const usage = await summarizeSavedUsage({
    activeProvider: defaultRoute?.provider ?? null,
    activeModel: defaultRoute?.model ?? null,
    configuredBudget: {
      tokenBudget: status.config.usage?.tokenBudget ?? null,
      costBudgetUsd: status.config.usage?.costBudgetUsd ?? null,
    },
  });

  sendJson(res, 200, {
    onboarded: status.onboarded,
    mode: status.onboarded ? "provider" : "foundation",
    missing: status.missing,
    provider: defaultRoute?.provider ?? null,
    model: defaultRoute?.model ?? null,
    routing: {
      default: defaultRoute ?? null,
      planning: planningRoute ?? null,
      coding: codingRoute ?? null,
    },
    providers: Object.keys(status.config.providers ?? {}),
    configPath: status.configPath,
    usage,
  });
}

async function handleGetProfile(res: ServerResponse, type: "soul" | "users"): Promise<void> {
  const filePath = type === "soul" ? resolveSoulPath() : resolveUsersPath();
  try {
    const content = await readFile(filePath, "utf-8");
    sendJson(res, 200, { content });
  } catch {
    sendJson(res, 200, { content: "" });
  }
}

async function handleGetConfig(res: ServerResponse): Promise<void> {
  const config = await readConfig();
  sendJson(res, 200, {
    config,
    configPath: resolveConfigPath(),
  });
}

function parseConfigObjectFromBody(body: unknown): T560Config {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be an object.");
  }
  const obj = body as Record<string, unknown>;

  if (typeof obj.raw === "string") {
    const parsed = JSON.parse(obj.raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("raw must parse to a JSON object.");
    }
    return parsed as T560Config;
  }

  if (obj.config && typeof obj.config === "object" && !Array.isArray(obj.config)) {
    return obj.config as T560Config;
  }

  return obj as T560Config;
}

function parseRoutingSlot(slotRaw: unknown): { provider: string; model: string } | null {
  if (!slotRaw || typeof slotRaw !== "object" || Array.isArray(slotRaw)) {
    return null;
  }
  const slot = slotRaw as Record<string, unknown>;
  const provider = String(slot.provider ?? "").trim();
  const model = String(slot.model ?? "").trim();
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}

function sanitizeProviderId(raw: unknown): string | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) {
    return null;
  }
  const normalized = value.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || null;
}

function parseProviderAuthMode(raw: unknown): "api_key" | "oauth" | "token" {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "oauth" || value === "token") {
    return value;
  }
  return "api_key";
}

function resolveCatalogRouteModel(
  providerId: string,
  slot: "default" | "planning" | "coding"
): string | undefined {
  const entry = listProviderCatalog().find((item) => item.id === providerId);
  if (!entry) {
    return undefined;
  }
  if (slot === "planning") {
    return entry.planningModel || entry.models[0];
  }
  if (slot === "coding") {
    return entry.codingModel || entry.models[0];
  }
  return entry.defaultModel || entry.models[0];
}

function resolveProviderRouteModel(
  providerId: string,
  profile: { models?: string[] } | undefined,
  slot: "default" | "planning" | "coding"
): string | undefined {
  const catalogModel = resolveCatalogRouteModel(providerId, slot);
  const rawModels = profile?.models;
  const providerModels = Array.isArray(rawModels)
    ? rawModels.map((item) => String(item).trim()).filter(Boolean)
    : [];
  if (catalogModel && providerModels.includes(catalogModel)) {
    return catalogModel;
  }
  if (catalogModel) {
    return catalogModel;
  }
  if (providerModels.length > 0) {
    return providerModels[0];
  }
  return undefined;
}

function parseTelegramDmPolicy(raw: unknown): "pairing" | "allowlist" | "open" | "disabled" {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "allowlist" || value === "open" || value === "disabled") {
    return value;
  }
  return "pairing";
}

function parseCredentialAuthMode(raw: unknown): CredentialAuthMode {
  const value = String(raw ?? "").trim().toLowerCase();
  if (
    value === "mfa" ||
    value === "passwordless" ||
    value === "passwordless_mfa_code" ||
    value === "mfa-code"
  ) {
    return "passwordless_mfa_code";
  }
  return "password";
}

function parseStringArray(raw: unknown): string[] {
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
}

function parseIntegerArray(raw: unknown): number[] {
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((entry) => Number(entry.trim()))
      .filter((value) => Number.isInteger(value));
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry) => Number(entry))
    .filter((value) => Number.isInteger(value));
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

function hasProviderCredential(profile: unknown): boolean {
  if (!profile || typeof profile !== "object") {
    return false;
  }
  const obj = profile as Record<string, unknown>;
  return (
    String(obj.apiKey ?? "").trim().length > 0 ||
    String(obj.oauthToken ?? "").trim().length > 0 ||
    String(obj.token ?? "").trim().length > 0
  );
}

function redactIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  if (!trimmed) {
    return "(empty)";
  }
  const at = trimmed.indexOf("@");
  if (at > 1) {
    return `${trimmed.slice(0, 1)}***${trimmed.slice(at)}`;
  }
  if (trimmed.length <= 3) {
    return `${trimmed[0] ?? "*"}**`;
  }
  return `${trimmed.slice(0, 2)}***${trimmed.slice(-1)}`;
}

async function buildSetupPayload(config: T560Config): Promise<Record<string, unknown>> {
  const routing = {
    default: resolveRoutingTarget(config, "default") ?? null,
    planning: resolveRoutingTarget(config, "planning") ?? null,
    coding: resolveRoutingTarget(config, "coding") ?? null,
  };
  const providers = Object.fromEntries(
    Object.entries(config.providers ?? {}).map(([providerId, profile]) => [
      providerId,
      {
        enabled: profile.enabled !== false,
        provider: profile.provider ?? providerId,
        authMode: profile.authMode ?? "api_key",
        models: Array.isArray(profile.models) ? profile.models : [],
        baseUrl: profile.baseUrl ?? "",
        api: profile.api ?? "",
        hasCredential: hasProviderCredential(profile),
      },
    ]),
  );
  const telegram = config.channels?.telegram;
  const vaultServices = await listConfiguredServices(process.cwd());
  return {
    catalog: listProviderCatalog(),
    providers,
    routing,
    telegram: {
      dmPolicy: telegram?.dmPolicy ?? "pairing",
      allowFrom: Array.isArray(telegram?.allowFrom) ? telegram?.allowFrom : [],
      allowedChatIds: Array.isArray(telegram?.allowedChatIds) ? telegram?.allowedChatIds : [],
      hasBotToken: Boolean(String(telegram?.botToken ?? "").trim()),
    },
    vault: {
      services: vaultServices,
    },
  };
}

async function handleGetSetup(res: ServerResponse): Promise<void> {
  const config = await readConfig();
  sendJson(res, 200, await buildSetupPayload(config));
}

async function handlePutSetupProvider(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendJson(res, 400, { error: "invalid_body", message: "Body must be an object." });
    return;
  }
  const obj = body as Record<string, unknown>;
  const providerId = sanitizeProviderId(obj.providerId);
  if (!providerId) {
    sendJson(res, 400, { error: "invalid_provider", message: "providerId is required." });
    return;
  }

  const config = await readConfig();
  const providers = { ...(config.providers ?? {}) };
  const existing = providers[providerId];
  const authMode = parseProviderAuthMode(obj.authMode ?? existing?.authMode ?? "api_key");
  const credential = typeof obj.credential === "string" ? obj.credential.trim() : "";
  const clearCredential = obj.clearCredential === true;
  const models = uniq(parseStringArray(obj.models));
  const next = {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : existing?.enabled ?? true,
    provider: providerId,
    authMode,
    apiKey: existing?.apiKey,
    oauthToken: existing?.oauthToken,
    token: existing?.token,
    baseUrl:
      obj.baseUrl === undefined
        ? existing?.baseUrl
        : String(obj.baseUrl ?? "").trim() || undefined,
    api:
      obj.api === undefined
        ? existing?.api
        : String(obj.api ?? "").trim() || undefined,
    models: models.length > 0 ? models : existing?.models ?? [],
  };

  if (clearCredential) {
    next.apiKey = undefined;
    next.oauthToken = undefined;
    next.token = undefined;
  } else if (credential) {
    if (authMode === "oauth") {
      next.apiKey = undefined;
      next.token = undefined;
      next.oauthToken = credential;
    } else if (authMode === "token") {
      next.apiKey = undefined;
      next.oauthToken = undefined;
      next.token = credential;
    } else {
      next.oauthToken = undefined;
      next.token = undefined;
      next.apiKey = credential;
    }
  }

  providers[providerId] = next;
  const nextConfig: T560Config = {
    ...config,
    providers,
  };
  await writeConfig(nextConfig);
  sendJson(res, 200, {
    ok: true,
    providerId,
    setup: await buildSetupPayload(await readConfig()),
  });
}

async function handleDeleteSetupProvider(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendJson(res, 400, { error: "invalid_body", message: "Body must be an object." });
    return;
  }
  const obj = body as Record<string, unknown>;
  const providerId = sanitizeProviderId(obj.providerId);
  if (!providerId) {
    sendJson(res, 400, { error: "invalid_provider", message: "providerId is required." });
    return;
  }

  const config = await readConfig();
  const providers = { ...(config.providers ?? {}) };
  if (!providers[providerId]) {
    sendJson(res, 404, { error: "provider_not_found", message: `${providerId} is not configured.` });
    return;
  }
  delete providers[providerId];

  const remainingProviderIds = Object.keys(providers);
  const fallbackProvider = remainingProviderIds[0] ?? "";

  const currentDefault = resolveRoutingTarget(config, "default");
  const currentPlanning = resolveRoutingTarget(config, "planning");
  const currentCoding = resolveRoutingTarget(config, "coding");

  const fallbackRoute = (
    current: { provider?: string; model?: string } | null | undefined,
    slot: "default" | "planning" | "coding"
  ): { provider: string; model: string } | undefined => {
    const currentProvider = String(current?.provider ?? "").trim();
    const currentModel = String(current?.model ?? "").trim();
    if (
      currentProvider &&
      currentModel &&
      currentProvider !== providerId &&
      providers[currentProvider]
    ) {
      return { provider: currentProvider, model: currentModel };
    }
    if (!fallbackProvider || !providers[fallbackProvider]) {
      return undefined;
    }
    const model = resolveProviderRouteModel(fallbackProvider, providers[fallbackProvider], slot);
    if (!model) {
      return undefined;
    }
    return { provider: fallbackProvider, model };
  };

  const defaultRoute = fallbackRoute(currentDefault, "default");
  const planningRoute = fallbackRoute(currentPlanning, "planning");
  const codingRoute = fallbackRoute(currentCoding, "coding");

  const nextRouting: NonNullable<T560Config["routing"]> = {};
  if (defaultRoute) {
    nextRouting.default = defaultRoute;
  }
  if (planningRoute) {
    nextRouting.planning = planningRoute;
  }
  if (codingRoute) {
    nextRouting.coding = codingRoute;
  }

  const nextModels: NonNullable<T560Config["models"]> = {};
  if (defaultRoute) {
    nextModels.default = `${defaultRoute.provider}/${defaultRoute.model}`;
  }
  if (planningRoute) {
    nextModels.planning = `${planningRoute.provider}/${planningRoute.model}`;
  }
  if (codingRoute) {
    nextModels.coding = `${codingRoute.provider}/${codingRoute.model}`;
  }

  const nextConfig: T560Config = {
    ...config,
    providers,
    provider: defaultRoute?.provider,
    models: Object.keys(nextModels).length > 0 ? nextModels : undefined,
    routing: Object.keys(nextRouting).length > 0 ? nextRouting : undefined,
  };

  await writeConfig(nextConfig);
  sendJson(res, 200, {
    ok: true,
    providerId,
    removed: true,
    setup: await buildSetupPayload(await readConfig()),
  });
}

async function handlePutSetupRouting(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendJson(res, 400, { error: "invalid_body", message: "Body must be an object." });
    return;
  }
  const obj = body as Record<string, unknown>;
  const defaultRoute = parseRoutingSlot(obj.default);
  const planningRoute = parseRoutingSlot(obj.planning);
  const codingRoute = parseRoutingSlot(obj.coding);
  if (!defaultRoute || !planningRoute || !codingRoute) {
    sendJson(res, 400, {
      error: "invalid_routing",
      message: "default, planning, and coding routes are required.",
    });
    return;
  }

  const config = await readConfig();
  const nextConfig: T560Config = {
    ...config,
    provider: defaultRoute.provider,
    models: {
      ...(config.models ?? {}),
      default: `${defaultRoute.provider}/${defaultRoute.model}`,
      planning: `${planningRoute.provider}/${planningRoute.model}`,
      coding: `${codingRoute.provider}/${codingRoute.model}`,
    },
    routing: {
      default: defaultRoute,
      planning: planningRoute,
      coding: codingRoute,
    },
  };
  await writeConfig(nextConfig);
  sendJson(res, 200, {
    ok: true,
    setup: await buildSetupPayload(await readConfig()),
  });
}

async function handlePutSetupTelegram(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendJson(res, 400, { error: "invalid_body", message: "Body must be an object." });
    return;
  }
  const obj = body as Record<string, unknown>;
  const config = await readConfig();
  const current = config.channels?.telegram;
  const dmPolicy = parseTelegramDmPolicy(obj.dmPolicy ?? current?.dmPolicy ?? "pairing");
  const allowFrom = uniq(parseStringArray(obj.allowFrom).map((entry) => entry.replace(/^(telegram|tg):/i, "")));
  const allowedChatIds = uniq(parseIntegerArray(obj.allowedChatIds).map((entry) => String(entry))).map((entry) =>
    Number(entry),
  );
  const tokenFromBody = obj.botToken;
  const botToken =
    tokenFromBody === undefined
      ? current?.botToken
      : String(tokenFromBody ?? "").trim() || undefined;
  const telegramConfig = {
    botToken,
    dmPolicy,
    allowFrom: allowFrom.length > 0 ? allowFrom : dmPolicy === "open" ? ["*"] : undefined,
    allowedChatIds: allowedChatIds.length > 0 ? allowedChatIds : undefined,
  };

  const nextConfig: T560Config = {
    ...config,
    channels: {
      ...(config.channels ?? {}),
      telegram: telegramConfig,
    },
  };
  await writeConfig(nextConfig);
  sendJson(res, 200, {
    ok: true,
    setup: await buildSetupPayload(await readConfig()),
  });
}

async function buildVaultEntries(workspaceDir: string): Promise<Array<Record<string, unknown>>> {
  const services = await listConfiguredServices(workspaceDir);
  const rows: Array<Record<string, unknown>> = [];
  for (const service of services) {
    const record = await getCredential({ workspaceDir, service });
    if (!record) {
      continue;
    }
    rows.push({
      service: record.service,
      identifierMasked: redactIdentifier(record.identifier),
      authMode: record.authMode,
      hasMfaCode: Boolean(record.mfaCode),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }
  return rows;
}

async function handleGetVault(res: ServerResponse): Promise<void> {
  const workspaceDir = process.cwd();
  const entries = await buildVaultEntries(workspaceDir);
  sendJson(res, 200, { entries });
}

async function handlePutVaultCredential(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendJson(res, 400, { error: "invalid_body", message: "Body must be an object." });
    return;
  }
  const obj = body as Record<string, unknown>;
  const service = normalizeSetupService(String(obj.service ?? ""));
  if (!service) {
    sendJson(res, 400, { error: "invalid_service", message: "service is required." });
    return;
  }
  const identifier = String(obj.identifier ?? "").trim();
  if (!identifier) {
    sendJson(res, 400, { error: "invalid_identifier", message: "identifier is required." });
    return;
  }
  const authMode = parseCredentialAuthMode(obj.authMode);
  const secretRaw = String(obj.secret ?? "");
  const secret = authMode === "password" ? secretRaw : "";
  if (authMode === "password" && !secret) {
    sendJson(res, 400, { error: "invalid_secret", message: "secret is required for password mode." });
    return;
  }
  const mfaCode = typeof obj.mfaCode === "string" ? obj.mfaCode.trim() : "";
  const workspaceDir = process.cwd();
  const result = await setCredential({
    workspaceDir,
    service,
    identifier,
    secret,
    authMode,
    ...(mfaCode ? { mfaCode } : {}),
  });
  sendJson(res, 200, {
    ok: true,
    service: result.service,
    created: result.created,
    entries: await buildVaultEntries(workspaceDir),
  });
}

async function handleDeleteVaultCredential(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendJson(res, 400, { error: "invalid_body", message: "Body must be an object." });
    return;
  }
  const obj = body as Record<string, unknown>;
  const service = normalizeSetupService(String(obj.service ?? ""));
  if (!service) {
    sendJson(res, 400, { error: "invalid_service", message: "service is required." });
    return;
  }
  const workspaceDir = process.cwd();
  const removed = await deleteCredential({ workspaceDir, service });
  sendJson(res, 200, {
    ok: true,
    removed,
    service,
    entries: await buildVaultEntries(workspaceDir),
  });
}

async function handlePutConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
    return;
  }

  let nextConfig: T560Config;
  try {
    nextConfig = parseConfigObjectFromBody(body);
  } catch (error: unknown) {
    sendJson(res, 400, {
      error: "invalid_config_payload",
      message: error instanceof Error ? error.message : "Invalid config payload.",
    });
    return;
  }

  try {
    await writeConfig(nextConfig);
    const saved = await readConfig();
    sendJson(res, 200, {
      ok: true,
      config: saved,
      configPath: resolveConfigPath(),
    });
  } catch (error: unknown) {
    sendJson(res, 500, {
      error: "config_write_failed",
      message: error instanceof Error ? error.message : "Failed to write config.",
    });
  }
}

async function handlePutProfile(req: IncomingMessage, res: ServerResponse, type: "soul" | "users"): Promise<void> {
  const raw = await readBody(req);
  let body: { content?: string } = {};
  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
    return;
  }

  if (typeof body.content !== "string") {
    sendJson(res, 400, { error: "missing_content", message: "The content field is required." });
    return;
  }

  await ensureStateDir();
  const filePath = type === "soul" ? resolveSoulPath() : resolveUsersPath();
  await writeFile(filePath, body.content, "utf-8");
  if (type === "users") {
    const legacyUserPath = resolveLegacyUserPath();
    if (legacyUserPath !== filePath) {
      await writeFile(legacyUserPath, body.content, "utf-8");
    }
  }

  if (type === "soul") {
    bustSoulPromptCache();
  } else {
    bustUsersPromptCache();
  }

  sendJson(res, 200, { ok: true });
}

async function readTextIfPresent(filePath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const trimmed = raw.trim();
    return trimmed ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

async function resolveUsersFallbackFile(): Promise<{ path: string; content?: string }> {
  const usersPath = resolveUsersPath();
  const usersContent = await readTextIfPresent(usersPath);
  if (usersContent) {
    return { path: usersPath, content: usersContent };
  }
  const legacyPath = resolveLegacyUserPath();
  const legacyContent = await readTextIfPresent(legacyPath);
  return {
    path: legacyContent ? legacyPath : usersPath,
    content: legacyContent
  };
}

async function handleGetBootstrapContext(res: ServerResponse): Promise<void> {
  const status = await readOnboardingStatus();
  const workspaceDir = process.cwd();
  const soulPath = resolveSoulPath();
  const soulContent = await readTextIfPresent(soulPath);
  const usersFallback = await resolveUsersFallbackFile();
  const maxChars = resolveBootstrapMaxChars(status.config);
  const files = await loadT560BootstrapContext({
    workspaceDir,
    maxChars,
    soulFallback: {
      path: soulPath,
      content: soulContent
    },
    userFallback: usersFallback
  });

  sendJson(res, 200, {
    workspaceDir,
    maxChars: maxChars ?? null,
    files
  });
}

async function handlePutBootstrapFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: { name?: string; content?: string } = {};
  try {
    body = JSON.parse(raw) as { name?: string; content?: string };
  } catch {
    sendJson(res, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
    return;
  }

  const name = String(body.name ?? "").trim();
  if (!name || !BOOTSTRAP_FILE_NAME_SET.has(name)) {
    sendJson(res, 400, {
      error: "invalid_bootstrap_name",
      message: `name must be one of: ${Array.from(BOOTSTRAP_FILE_NAME_SET).join(", ")}`,
    });
    return;
  }
  if (typeof body.content !== "string") {
    sendJson(res, 400, { error: "missing_content", message: "The content field is required." });
    return;
  }

  const filePath = join(process.cwd(), name);
  await writeFile(filePath, body.content, "utf-8");
  sendJson(res, 200, { ok: true, name, path: filePath });
}

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  opts: DashboardServerOptions,
): Promise<void> {
  const raw = await readBody(req);
  let body: ChatRequest = {};
  try {
    body = JSON.parse(raw) as ChatRequest;
  } catch {
    sendJson(res, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
    return;
  }

  const message = (body.message ?? "").trim();
  if (!message) {
    sendJson(res, 400, { error: "missing_message", message: "The message field is required." });
    return;
  }
  if (isHeartbeatCheckMessage(message)) {
    res.statusCode = 204;
    res.end();
    return;
  }

  const reply = await opts.handleMessage({
    channel: "webchat",
    message,
    sessionId: body.sessionKey ? `webchat:${body.sessionKey}` : "webchat:local",
    externalUserId: "webchat-user",
    receivedAt: Date.now(),
  }).catch((error: unknown) => buildFallbackChatResponse(error));
  sendJson(res, 200, reply);
}

function handleEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  opts: DashboardServerOptions,
  url: URL
): void {
  if (!opts.subscribeEvents) {
    sendJson(res, 404, { error: "events_unavailable" });
    return;
  }

  const sessionKey = url.searchParams.get("sessionKey")?.trim() || "local";

  setSecurityHeaders(res);
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.write(": connected\n\n");

  const unsubscribe = opts.subscribeEvents({
    sessionId: `webchat:${sessionKey}`,
    onEvent: (event) => {
      res.write("event: agent-event\n");
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  });

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.once("close", cleanup);
  req.once("error", cleanup);
}

/* ═══════════════════════════════════════════
   WebSocket Message Handler
   ═══════════════════════════════════════════ */

async function handleWsMessage(
  client: WsClient,
  frame: WsFrame,
  opts: DashboardServerOptions,
): Promise<void> {
  if (frame.type !== "req" || !frame.method || !frame.id) return;

  switch (frame.method) {
    case "connect": {
      // Gather status for the snapshot
      try {
        const status = await readOnboardingStatus();
        const defaultRoute = resolveRoutingTarget(status.config, "default");
        sendWsResponse(client.ws, frame.id, true, {
          snapshot: {
            status: {
              mode: status.onboarded ? "provider" : "foundation",
              provider: defaultRoute?.provider ?? null,
              model: defaultRoute?.model ?? null,
              onboardingRequired: !status.onboarded,
              missing: status.missing,
              config: {
                configPath: status.configPath,
                providers: Object.keys(status.config.providers ?? {}),
              },
            },
            sessionKey: client.sessionKey,
          },
        });
      } catch (err) {
        sendWsResponse(client.ws, frame.id, false, undefined, {
          code: "connect_failed",
          message: err instanceof Error ? err.message : "Connect failed",
        });
      }
      break;
    }

    case "chat.send": {
      const params = frame.params as { message?: string; sessionKey?: string } | undefined;
      const message = (params?.message ?? "").trim();
      if (!message) {
        sendWsResponse(client.ws, frame.id, false, undefined, {
          code: "missing_message",
          message: "The message field is required.",
        });
        return;
      }

      if (params?.sessionKey) {
        client.sessionKey = params.sessionKey;
        bindClientEvents(client, opts);
      }

      // Acknowledge the request
      sendWsResponse(client.ws, frame.id, true);

      // Notify: sending
      sendWsEvent(client.ws, "chat.sending");

      try {
        if (isHeartbeatCheckMessage(message)) {
          return;
        }

        const reply = await opts.handleMessage({
          channel: "webchat",
          message,
          sessionId: `webchat:${client.sessionKey}`,
          externalUserId: "webchat-user",
          receivedAt: Date.now(),
        });

        sendWsEvent(client.ws, "chat", toWsAssistantChatPayload(reply));
      } catch (err) {
        sendWsEvent(client.ws, "chat", toWsAssistantChatPayload(buildFallbackChatResponse(err)));
      } finally {
        sendWsEvent(client.ws, "chat.done");
      }
      break;
    }

    case "chat.history": {
      try {
        const params = frame.params as { sessionKey?: string; limit?: number } | undefined;
        if (params?.sessionKey) {
          client.sessionKey = params.sessionKey;
          bindClientEvents(client, opts);
        }
        const limit = normalizeHistoryLimit(params?.limit);
        const messages = await readWebchatHistory(client.sessionKey, limit);
        sendWsResponse(client.ws, frame.id, true, {
          sessionKey: client.sessionKey,
          messages,
        });
      } catch (err) {
        sendWsResponse(client.ws, frame.id, false, undefined, {
          code: "history_failed",
          message: summarizeErrorMessage(err),
        });
      }
      break;
    }

    case "chat.inject": {
      try {
        const params = frame.params as { message?: string; sessionKey?: string } | undefined;
        const message = String(params?.message ?? "").trim();
        if (!message) {
          sendWsResponse(client.ws, frame.id, false, undefined, {
            code: "missing_message",
            message: "The message field is required.",
          });
          return;
        }
        if (params?.sessionKey) {
          client.sessionKey = params.sessionKey;
          bindClientEvents(client, opts);
        }
        const sessionId = `webchat:${client.sessionKey}`;
        const history = await loadSessionMessages(sessionId);
        history.push({
          role: "assistant",
          content: [{ type: "text", text: message }],
          api: "openai-responses",
          provider: "webchat",
          model: "manual-inject",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        });
        await saveSessionMessages(sessionId, history);
        sendWsResponse(client.ws, frame.id, true, { ok: true, sessionKey: client.sessionKey });
        sendWsEvent(client.ws, "chat", {
          id: crypto.randomUUID(),
          role: "assistant",
          message,
          thinking: null,
          toolCalls: [],
          provider: null,
          model: null,
          timestamp: Date.now(),
          injected: true,
        });
      } catch (err) {
        sendWsResponse(client.ws, frame.id, false, undefined, {
          code: "inject_failed",
          message: summarizeErrorMessage(err),
        });
      }
      break;
    }

    case "chat.abort": {
      // For now just acknowledge — actual abort requires AbortController integration
      sendWsResponse(client.ws, frame.id, true);
      sendWsEvent(client.ws, "chat.done");
      break;
    }

    default: {
      sendWsResponse(client.ws, frame.id, false, undefined, {
        code: "unknown_method",
        message: `Unknown method: ${frame.method}`,
      });
    }
  }
}

/* ═══════════════════════════════════════════
   HTTP Router
   ═══════════════════════════════════════════ */

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: DashboardServerOptions,
  uiRoot: string | null,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;

  setSecurityHeaders(res);

  // API routes
  if (method === "GET" && pathname === "/api/status") {
    await handleStatus(res);
    return;
  }
  if (method === "GET" && pathname === "/api/events") {
    handleEventStream(req, res, opts, url);
    return;
  }
  if (method === "POST" && pathname === "/api/chat") {
    await handleChat(req, res, opts);
    return;
  }
  if (method === "GET" && pathname === "/api/profile/soul") {
    await handleGetProfile(res, "soul");
    return;
  }
  if (method === "PUT" && pathname === "/api/profile/soul") {
    await handlePutProfile(req, res, "soul");
    return;
  }
  if (method === "GET" && pathname === "/api/profile/users") {
    await handleGetProfile(res, "users");
    return;
  }
  if (method === "PUT" && pathname === "/api/profile/users") {
    await handlePutProfile(req, res, "users");
    return;
  }
  if (method === "GET" && pathname === "/api/config") {
    await handleGetConfig(res);
    return;
  }
  if (method === "PUT" && pathname === "/api/config") {
    await handlePutConfig(req, res);
    return;
  }
  if (method === "GET" && pathname === "/api/context/bootstrap") {
    await handleGetBootstrapContext(res);
    return;
  }
  if (method === "PUT" && pathname === "/api/context/bootstrap") {
    await handlePutBootstrapFile(req, res);
    return;
  }
  if (method === "GET" && pathname === "/api/setup") {
    await handleGetSetup(res);
    return;
  }
  if (method === "PUT" && pathname === "/api/setup/provider") {
    await handlePutSetupProvider(req, res);
    return;
  }
  if (method === "DELETE" && pathname === "/api/setup/provider") {
    await handleDeleteSetupProvider(req, res);
    return;
  }
  if (method === "PUT" && pathname === "/api/setup/routing") {
    await handlePutSetupRouting(req, res);
    return;
  }
  if (method === "PUT" && pathname === "/api/setup/telegram") {
    await handlePutSetupTelegram(req, res);
    return;
  }
  if (method === "GET" && pathname === "/api/vault") {
    await handleGetVault(res);
    return;
  }
  if (method === "PUT" && pathname === "/api/vault") {
    await handlePutVaultCredential(req, res);
    return;
  }
  if (method === "DELETE" && pathname === "/api/vault") {
    await handleDeleteVaultCredential(req, res);
    return;
  }
  if (method === "GET" && pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method === "GET" && pathname === "/control-ui-bootstrap-config.json") {
    sendJson(res, 200, { basePath: "/", assistantName: "t560" });
    return;
  }

  // Static file serving for SPA
  if (method === "GET" && uiRoot) {
    // Try to serve the exact file
    if (serveStaticFile(res, uiRoot, pathname)) return;

    // SPA fallback: serve index.html for non-file paths
    if (!pathname.includes(".")) {
      if (serveStaticFile(res, uiRoot, "/index.html")) return;
    }
  }

  if (method === "GET" && (pathname === "/" || pathname === "/index.html") && !uiRoot) {
    res.statusCode = 503;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      [
        "<!doctype html>",
        "<html><head><meta charset='utf-8'/>",
        "<meta name='viewport' content='width=device-width,initial-scale=1'/>",
        "<title>t560 UI unavailable</title></head>",
        "<body style='font-family:system-ui,sans-serif;padding:24px'>",
        "<h1>t560 UI unavailable</h1>",
        "<p>The web UI bundle is not available yet.</p>",
        "<p>Run: <code>cd ui && npm install && npm run build</code></p>",
        "<p>Then restart t560.</p>",
        "</body></html>",
      ].join(""),
    );
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

/* ═══════════════════════════════════════════
   Server Startup
   ═══════════════════════════════════════════ */

export async function startDashboardServer(opts: DashboardServerOptions): Promise<DashboardServer> {
  const preferredPort = parsePort(process.env.T560_WEB_PORT);
  const bindHost = parseBindHost(process.env.T560_WEB_HOST);

  const uiResult = ensureControlUiBuilt();
  const uiRoot = uiResult.uiRoot;

  const server = createServer((req, res) => {
    routeRequest(req, res, opts, uiRoot).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: "internal_error", message });
    });
  });

  // WebSocket setup
  let wss: import("ws").WebSocketServer | null = null;
  const clients = new Set<WsClient>();

  try {
    const wsModule = await import("ws");
    const WebSocketServer = wsModule.WebSocketServer;

    wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/ws") {
        wss!.handleUpgrade(req, socket, head, (ws) => {
          wss!.emit("connection", ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    wss.on("connection", (ws) => {
      const client: WsClient = {
        ws,
        id: crypto.randomUUID(),
        sessionKey: crypto.randomUUID().slice(0, 8),
      };
      clients.add(client);
      bindClientEvents(client, opts);

      ws.on("message", (data) => {
        try {
          const frame = JSON.parse(data.toString()) as WsFrame;
          handleWsMessage(client, frame, opts).catch(() => {
            // Error already handled in handleWsMessage
          });
        } catch {
          // Ignore malformed frames
        }
      });

      ws.on("close", () => {
        client.unsubscribeEvents?.();
        clients.delete(client);
      });

      ws.on("error", () => {
        client.unsubscribeEvents?.();
        clients.delete(client);
      });
    });
  } catch {
    // ws module not available — WebSocket disabled, HTTP-only mode
    console.warn("[dashboard] ws module not found — WebSocket disabled. Install with: npm install ws");
  }

  const port = await startListening(server, preferredPort, bindHost);
  const localUrl = `http://127.0.0.1:${port}`;
  const tailscale = await resolveTailscaleStatus();
  const loopbackOnly = bindHost === "127.0.0.1" || bindHost === "localhost" || bindHost === "::1";
  const tailscaleUrl = !loopbackOnly && tailscale.ip ? `http://${tailscale.ip}:${port}` : null;
  const url = localUrl;

  if (uiRoot) {
    if (uiResult.autoBuilt) {
      console.warn(`[dashboard] UI ready at ${uiRoot}`);
    }
  } else {
    console.warn("[dashboard] UI unavailable. Run: cd ui && npm install && npm run build");
  }

  return {
    port,
    url,
    localUrl,
    tailscaleUrl,
    bindHost,
    close: async () => {
      // Close all WebSocket connections
      for (const client of clients) {
        try { client.ws.close(1000, "Server shutting down"); } catch {}
      }
      clients.clear();
      if (wss) {
        try { wss.close(); } catch {}
      }
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
