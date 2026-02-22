import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export function ensureGatewayDirs(env = process.env) {
  const base = resolveStateDir(env);
  const sessionsDir = path.join(base, "sessions");
  const logsDir = path.join(base, "logs");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  return { base, sessionsDir, logsDir };
}

export function loadSession(sessionId, env = process.env) {
  const { sessionsDir } = ensureGatewayDirs(env);
  const p = path.join(sessionsDir, `${sessionId}.json`);
  if (!fs.existsSync(p)) {
    return {
      path: p,
      session: { version: 2, sessionId, messages: [], mode: "default", modelRefOverride: "", meta: {} },
    };
  }
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    const msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
    const mode = typeof parsed?.mode === "string" ? parsed.mode : "default";
    const modelRefOverride = typeof parsed?.modelRefOverride === "string" ? parsed.modelRefOverride : "";
    const meta = parsed?.meta && typeof parsed.meta === "object" && !Array.isArray(parsed.meta) ? parsed.meta : {};
    return { path: p, session: { version: 2, sessionId, messages: msgs, mode, modelRefOverride, meta } };
  } catch {
    return {
      path: p,
      session: { version: 2, sessionId, messages: [], mode: "default", modelRefOverride: "", meta: {} },
    };
  }
}

export function saveSession(sessionId, session, env = process.env) {
  const { sessionsDir } = ensureGatewayDirs(env);
  const p = path.join(sessionsDir, `${sessionId}.json`);
  const payload = {
    version: 2,
    sessionId,
    messages: Array.isArray(session?.messages) ? session.messages : [],
    mode: typeof session?.mode === "string" ? session.mode : "default",
    modelRefOverride: typeof session?.modelRefOverride === "string" ? session.modelRefOverride : "",
    meta: session?.meta && typeof session.meta === "object" && !Array.isArray(session.meta) ? session.meta : {},
  };
  fs.writeFileSync(p, JSON.stringify(payload, null, 2) + "\n", "utf8");
  try {
    fs.chmodSync(p, 0o600);
  } catch {}
  return p;
}

export function listSessions(env = process.env) {
  const { sessionsDir } = ensureGatewayDirs(env);
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith(".json")) continue;
    const id = ent.name.slice(0, -".json".length);
    const full = path.join(sessionsDir, ent.name);
    const snap = loadSession(id, env).session;
    const messages = Array.isArray(snap?.messages) ? snap.messages : [];
    const last = messages[messages.length - 1] ?? null;
    let updatedAt = 0;
    try {
      updatedAt = Number(fs.statSync(full).mtimeMs || 0);
    } catch {}
    out.push({
      id,
      path: full,
      messageCount: messages.length,
      updatedAt,
      mode: typeof snap?.mode === "string" ? snap.mode : "default",
      modelRefOverride: typeof snap?.modelRefOverride === "string" ? snap.modelRefOverride : "",
      lastModelRef:
        typeof snap?.meta?.lastModelRef === "string"
          ? snap.meta.lastModelRef
          : typeof snap?.meta?.modelRef === "string"
            ? snap.meta.modelRef
            : "",
      lastMessageRole: typeof last?.role === "string" ? last.role : "",
      lastMessagePreview: typeof last?.content === "string" ? String(last.content).slice(0, 180) : "",
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  return out;
}
