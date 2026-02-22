import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import express from "express";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";

import { loadConfig, saveConfig, loadSecrets, redactConfigSummary } from "../config/store.js";
import { ensureGatewayDirs, loadSession, saveSession } from "./state.js";
import { startTelegramBot } from "../channels/telegram.js";
import { startSlackBot } from "../channels/slack.js";
import { runAgentTurn } from "./agent.js";
import { parseModelRef } from "../models/model_ref.js";
import { ensureFreshOpenAICodexOAuth } from "../auth/openai_codex_oauth.js";
import { createWizardSessionTracker } from "./wizard_sessions.js";
import { buildIdentityInstructions } from "../workspace/identity.js";
import { approvePairingCode, listPairingRequests } from "../pairing/store.js";
import { resolveStateDir } from "../config/paths.js";
import { createGatewayLogger, readGatewayLogsTail, resolveGatewayLogPath } from "./logging.js";
import { auditSecurity } from "../security/audit.js";
import { ensureWorkspaceBootstrap } from "../workspace/bootstrap.js";
import { handleChatCommand } from "./chat_commands.js";
import { resolveModelRefForTurn } from "./model_select.js";
import { detectTailscale } from "../network/tailscale.js";
import { startCronHeartbeat } from "../cron/heartbeat.js";

function nowIso() {
  return new Date().toISOString();
}

function resolveTurnSelection(cfg, session, message) {
  return resolveModelRefForTurn({ cfg, session, message });
}

function asEnabled(value, defaultValue = true) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return defaultValue;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return defaultValue;
}

function resolveGatewaySettings(cfg, secrets, env = process.env) {
  const envPort = env.T560_GATEWAY_PORT ? Number.parseInt(env.T560_GATEWAY_PORT, 10) : undefined;
  const port = Number.isFinite(envPort) ? envPort : Number(cfg?.gateway?.port ?? 18789);

  const bindRaw = (env.T560_GATEWAY_BIND ?? cfg?.gateway?.bind ?? "loopback").toString().trim();
  let bind = bindRaw === "loopback" ? "127.0.0.1" : bindRaw === "lan" ? "0.0.0.0" : String(bindRaw);
  const authMode = String(cfg?.gateway?.auth?.mode ?? "token");
  const token = String(secrets?.T560_GATEWAY_TOKEN ?? "").trim();
  const password = String(secrets?.T560_GATEWAY_PASSWORD ?? "").trim();
  const tailscale = detectTailscale(env);
  const shouldAutoExposeOnTailscale = asEnabled(env.T560_TAILSCALE_EXPOSE, true);
  const hasGatewayAuthSecret = authMode === "password" ? Boolean(password) : Boolean(token);

  // If gateway is loopback-only but Tailscale is active, expose web chat via tailnet.
  // We only do this when gateway auth is configured to avoid unauthenticated exposure.
  if (bindRaw === "loopback" && tailscale.enabled && shouldAutoExposeOnTailscale && hasGatewayAuthSecret) {
    bind = "0.0.0.0";
  }

  const tailscaleReachable = Boolean(
    tailscale.enabled && (bind === "0.0.0.0" || bind === "::" || bind === String(tailscale.ip ?? "")),
  );

  return { port, bindRaw, bind, authMode, token, password, tailscale, tailscaleReachable };
}

function isAuthed({ authMode, token, password }, provided) {
  const value = String(provided ?? "").trim();
  if (authMode === "password") {
    return Boolean(password) && value === password;
  }
  // default: token
  return Boolean(token) && value === token;
}

function getWebSocketToken(req) {
  try {
    const u = new URL(req.url, "http://localhost");
    return u.searchParams.get("token") || "";
  } catch {
    return "";
  }
}

function getWebSocketSession(req) {
  try {
    const u = new URL(req.url, "http://localhost");
    return u.searchParams.get("session") || "";
  } catch {
    return "";
  }
}

function extractBearerToken(req) {
  const auth = String(req.headers.authorization ?? "");
  if (!auth.startsWith("Bearer ")) return "";
  return auth.slice("Bearer ".length).trim();
}

async function notifyTelegramApproved({ token, chatId }) {
  const tok = String(token ?? "").trim();
  const cid = String(chatId ?? "").trim();
  if (!tok || !cid) return { ok: false, error: "missing token/chatId" };
  const url = `https://api.telegram.org/bot${tok}/sendMessage`;
  const body = { chat_id: cid, text: "t560: pairing approved. You can message the bot now." };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: text || `HTTP ${res.status}` };
  }
  return { ok: true };
}

export async function startGateway({ env = process.env, log = console.log } = {}) {
  const cfgSnap = loadConfig(env);
  const secretsSnap = loadSecrets(env);
  const cfg = cfgSnap?.config ?? {};
  const secrets = secretsSnap?.secrets ?? {};

  const stateDir = resolveStateDir(env);
  const gwLog = createGatewayLogger({ stateDir, also: log });

  const gw = resolveGatewaySettings(cfg, secrets, env);

  const buildAuthPayload = ({ cfgValue, secretsValue, codexValue }) => ({
    openai: {
      apiKey: String(secretsValue.OPENAI_API_KEY ?? "").trim(),
      organization: cfgValue?.openai?.organization,
      project: cfgValue?.openai?.project,
    },
    codex: codexValue,
    anthropic: { apiKey: String(secretsValue.ANTHROPIC_API_KEY ?? "").trim() },
    deepseek: { apiKey: String(secretsValue.DEEPSEEK_API_KEY ?? "").trim() },
    openrouter: { apiKey: String(secretsValue.OPENROUTER_API_KEY ?? "").trim() },
    xai: { apiKey: String(secretsValue.XAI_API_KEY ?? "").trim() },
    together: { apiKey: String(secretsValue.TOGETHER_API_KEY ?? "").trim() },
    venice: { apiKey: String(secretsValue.VENICE_API_KEY ?? "").trim() },
    moonshot: { apiKey: String(secretsValue.MOONSHOT_API_KEY ?? "").trim() },
    minimax: { apiKey: String(secretsValue.MINIMAX_API_KEY ?? "").trim() },
    xiaomi: { apiKey: String(secretsValue.XIAOMI_API_KEY ?? "").trim() },
    synthetic: { apiKey: String(secretsValue.SYNTHETIC_API_KEY ?? "").trim() },
    "cloudflare-ai-gateway": {
      apiKey: String(secretsValue.CLOUDFLARE_AI_GATEWAY_API_KEY ?? "").trim(),
      accountId: String(cfgValue?.providers?.cloudflareAiGateway?.accountId ?? "").trim(),
      gatewayId: String(cfgValue?.providers?.cloudflareAiGateway?.gatewayId ?? "").trim(),
    },
  });

  const invokeSessionFromHeartbeat = async ({
    sessionId: targetSessionId,
    message,
    timeoutSeconds = 30,
    runId,
    label,
    spawnedBy,
    modelRefOverride,
    thinking,
    cleanup = "keep",
    runTimeoutSeconds = 0,
  }) => {
    const sessionId = String(targetSessionId ?? "").trim();
    const text = String(message ?? "").trim();
    if (!sessionId) return { ok: false, status: "error", error: "Missing session id." };
    if (!text) return { ok: false, status: "error", error: "Missing message." };

    const cfgNow = loadConfig(env).config ?? {};
    const secretsNow = loadSecrets(env).secrets ?? {};
    const snap = loadSession(sessionId, env);
    let session = snap.session;
    const sessionPath = snap.path;
    session = {
      ...session,
      modelRefOverride: modelRefOverride ? String(modelRefOverride).trim() : session.modelRefOverride,
      meta: {
        ...(session?.meta && typeof session.meta === "object" ? session.meta : {}),
        ...(label ? { label: String(label).trim() } : {}),
        ...(spawnedBy ? { spawnedBy: String(spawnedBy).trim() } : {}),
        ...(thinking ? { thinking: String(thinking).trim() } : {}),
        ...(runTimeoutSeconds ? { runTimeoutSeconds: Math.max(0, Math.floor(Number(runTimeoutSeconds))) } : {}),
      },
    };
    const startMessages = Array.isArray(session.messages) ? session.messages : [];
    session = { ...session, messages: [...startMessages, { role: "user", content: text }] };
    const selected = resolveTurnSelection(cfgNow, session, text);
    const modelRefSelected = selected.modelRef;
    session = {
      ...selected.session,
      meta: {
        ...(selected.session?.meta && typeof selected.session.meta === "object" ? selected.session.meta : {}),
        lastModelRef: modelRefSelected,
      },
    };
    saveSession(sessionId, session, env);

    const parsed = parseModelRef(modelRefSelected);
    let codex = null;
    if (parsed.provider === "openai-codex") {
      try {
        const { creds } = await ensureFreshOpenAICodexOAuth(env);
        codex = { accessToken: String(creds.access ?? "").trim(), accountId: String(creds.accountId ?? "").trim() };
      } catch (err) {
        return { ok: false, status: "error", error: String(err?.message ?? err), runId: runId ?? "" };
      }
    }
    const auth = buildAuthPayload({ cfgValue: cfgNow, secretsValue: secretsNow, codexValue: codex });
    const identity = buildIdentityInstructions({ workspaceDir: cfgNow?.workspaceDir });
    const effectiveRunId = String(runId ?? "").trim() || crypto.randomUUID?.() || `${Date.now()}`;

    const execute = async () => {
      const turn = await runAgentTurn({
        env,
        sessionId,
        cfg: cfgNow,
        identity,
        auth,
        modelRef: modelRefSelected,
        enableEmailTools: Boolean(cfgNow?.email?.enabled && cfgNow?.email?.allowAgentSend),
        enableGitHubTools: Boolean(cfgNow?.github?.enabled && cfgNow?.github?.allowAgentWrite),
        enableWebTools: Boolean(cfgNow?.tools?.web?.search?.enabled || cfgNow?.tools?.web?.fetch?.enabled),
        enableTerminalTools: Boolean(cfgNow?.tools?.terminal?.enabled && cfgNow?.tools?.terminal?.allowAgentExec),
        workspaceDir: cfgNow?.workspaceDir,
        messages: session.messages,
      });
      const reply = String(turn?.reply ?? "").trim() || "(empty response)";
      const latest = loadSession(sessionId, env).session;
      const latestMessages = Array.isArray(latest.messages) ? latest.messages : [];
      saveSession(
        sessionId,
        {
          ...latest,
          meta: {
            ...(latest?.meta && typeof latest.meta === "object" ? latest.meta : {}),
            lastRunId: effectiveRunId,
            lastModelRef: modelRefSelected,
          },
          messages: [...latestMessages, { role: "assistant", content: reply }],
        },
        env,
      );
      return { ok: true, status: "ok", runId: effectiveRunId, reply };
    };

    if (Number(timeoutSeconds) === 0) {
      void execute()
        .catch((err) => {
          gwLog(`[t560] cron invoke error (${sessionId}): ${String(err?.message ?? err)}`);
        })
        .finally(() => {
          if (cleanup === "delete") {
            try {
              if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
            } catch {}
          }
        });
      return { ok: true, status: "accepted", runId: effectiveRunId };
    }

    const timeoutMs = Math.max(1, Math.floor(Number(timeoutSeconds) || 30)) * 1000;
    const timeoutResult = await Promise.race([
      execute(),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, status: "timeout", error: "timeout" }), timeoutMs)),
    ]);
    if (cleanup === "delete") {
      try {
        if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
      } catch {}
    }
    return timeoutResult;
  };

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const wizardTracker = createWizardSessionTracker();

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const publicDir = path.join(__dirname, "public");
  app.use("/", express.static(publicDir));

  // SPA fallback for route-style tabs: /chat, /logs, /config, etc.
  // IMPORTANT: keep this before /api handlers? No: we only fall back for GETs that
  // are not /api/* and not /health.
  app.get(/^\/(?!api\/|health$|ws$).*/, (req, res, next) => {
    if (req.method !== "GET") return next();
    // Let static win for real files.
    const reqPath = String(req.path ?? "");
    const ext = path.extname(reqPath);
    if (ext) return next();
    res.sendFile(path.join(publicDir, "index.html"));
  });

  app.get("/health", (req, res) => {
    res.json({
      ok: true,
      time: nowIso(),
      authMode: gw.authMode,
    });
  });

  app.get("/api/hello", (req, res) => {
    const token = extractBearerToken(req);
    if (!isAuthed(gw, token)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
    res.json({
      ok: true,
      time: nowIso(),
      gateway: { bind: gw.bind, port: gw.port, authMode: gw.authMode },
      tailscale: gw.tailscaleReachable ? { enabled: true, ip: gw.tailscale.ip } : { enabled: false },
      summary: redactConfigSummary(cfg),
      models: cfg?.models ?? null,
      channels: cfg?.channels ?? null,
    });
  });

  app.get("/api/config", (req, res) => {
    const token = extractBearerToken(req);
    if (!isAuthed(gw, token)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
    res.json({ ok: true, summary: redactConfigSummary(cfg), config: cfg });
  });

  app.post("/api/config", (req, res) => {
    const token = extractBearerToken(req);
    if (!isAuthed(gw, token)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
    const body = req.body?.config;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
