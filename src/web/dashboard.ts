import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL, fileURLToPath } from "node:url";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
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
  // Try dist/control-ui relative to the project root
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // From dist/web/dashboard.js -> dist/control-ui
  const distRoot = join(__dirname, "..", "control-ui");
  if (existsSync(join(distRoot, "index.html"))) return distRoot;

  // Try from src/web -> ../../dist/control-ui (dev mode)
  const devRoot = join(__dirname, "..", "..", "dist", "control-ui");
  if (existsSync(join(devRoot, "index.html"))) return devRoot;

  return null;
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
          content: message,
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

  sendJson(res, 404, { error: "not_found" });
}

/* ═══════════════════════════════════════════
   Server Startup
   ═══════════════════════════════════════════ */

export async function startDashboardServer(opts: DashboardServerOptions): Promise<DashboardServer> {
  const preferredPort = parsePort(process.env.T560_WEB_PORT);
  const bindHost = parseBindHost(process.env.T560_WEB_HOST);

  const uiRoot = resolveUiRoot();

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
    // SPA mode
  } else {
    console.warn("[dashboard] UI not built — run: cd ui && npm install && npx vite build");
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
