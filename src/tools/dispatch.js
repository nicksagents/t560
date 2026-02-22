import { loadConfig, loadSecrets, saveConfig } from "../config/store.js";
import { saveMemory, searchMemories } from "../memory/store.js";
import { braveWebSearch } from "../web/brave_search.js";
import { duckDuckGoSearch } from "../web/duckduckgo_search.js";
import { webFetch } from "../web/fetch.js";
import { sendEmail } from "../email/smtp.js";
import { createGitHubClient } from "../github/client.js";
import { listSessions, loadSession, saveSession } from "../gateway/state.js";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { resolveStateDir } from "../config/paths.js";
import {
  appendCronRun,
  computeNextRunAtMs,
  getCronStatus,
  isCronJobDue,
  listCronJobs,
  listCronRuns,
  loadCronState,
  patchCronJob,
  removeCronJob,
  updateCronWake,
  upsertCronJob,
} from "../cron/store.js";
import {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserCloseTab,
  browserConsole,
  browserNavigate,
  browserOpenTab,
  browserPdf,
  browserProfiles,
  browserScreenshot,
  browserSnapshot,
  browserStart,
  browserStatus,
  browserStop,
  browserTabs,
  browserFocusTab,
} from "../browser/store.js";
import {
  approveNodeRequest,
  describeNode,
  invokeNodeCommand,
  listNodePending,
  listNodes as listRegisteredNodes,
  rejectNodeRequest,
  resolveNodeIdFromList,
} from "../nodes/store.js";

function safeJsonParse(raw) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

function trimOutput(text, maxChars) {
  const raw = String(text ?? "");
  const n = Number.isFinite(maxChars) ? Number(maxChars) : 10_000;
  if (raw.length <= n) return raw;
  return raw.slice(0, n) + "\n\n[truncated]";
}

function parseAllowPrefixes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .map((v) => v.toLowerCase());
}

function firstToken(command) {
  const c = String(command ?? "").trim();
  if (!c) return "";
  const tok = c.split(/\s+/g)[0] || "";
  const base = path.basename(tok).trim();
  return base.toLowerCase();
}

function isInsideDir(parentDir, maybeChild) {
  const parent = path.resolve(String(parentDir ?? ""));
  const child = path.resolve(String(maybeChild ?? ""));
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function hasBlockedShellPattern(command) {
  const c = String(command ?? "");
  const blocked = [
    /\brm\s+-rf\s+\/\b/i,
    /\bmkfs(\.| )/i,
    /\bdd\s+if=/i,
    /\bshutdown\b/i,
    /\breboot\b/i,
    /\bpoweroff\b/i,
    />\s*\/dev\//i,
    /\bchmod\s+777\b/i,
  ];
  return blocked.some((re) => re.test(c));
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function hasAnyPrefix(value, prefixes) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return false;
  return prefixes.some((p) => text.startsWith(String(p ?? "").toLowerCase()));
}

function resolveSessionByLabel({ label, agentId, env }) {
  const wantedLabel = String(label ?? "").trim().toLowerCase();
  if (!wantedLabel) return "";
  const wantedAgent = String(agentId ?? "").trim().toLowerCase();
  const sessions = listSessions(env);
  for (const row of sessions) {
    const id = String(row?.id ?? "").trim();
    if (!id) continue;
    if (wantedAgent && !hasAnyPrefix(id, [`agent:${wantedAgent}:`])) continue;
    const snap = loadSession(id, env).session;
    const meta = snap?.meta && typeof snap.meta === "object" ? snap.meta : {};
    const labelValue = String(meta?.label ?? "").trim().toLowerCase();
    if (labelValue && labelValue === wantedLabel) {
      return id;
    }
  }
  return "";
}

function classifySessionKind(sessionId) {
  const id = String(sessionId ?? "").trim().toLowerCase();
  if (!id) return "other";
  if (id === "main" || id === "terminal" || id === "webchat") return "main";
  if (id.startsWith("telegram_group_") || id.startsWith("slack_group_") || id.includes(":group:")) return "group";
  if (id.startsWith("cron:") || id.startsWith("cron_")) return "cron";
  if (id.startsWith("hook:") || id.startsWith("hook_")) return "hook";
  if (id.startsWith("node:") || id.startsWith("node_")) return "node";
  return "other";
}

function stableJson(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function computeConfigHash(config) {
  return crypto.createHash("sha256").update(stableJson(config)).digest("hex");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, patch) {
  if (!isRecord(base)) return isRecord(patch) ? { ...patch } : patch;
  if (!isRecord(patch)) return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const prev = out[key];
    if (isRecord(prev) && isRecord(value)) out[key] = deepMerge(prev, value);
    else out[key] = value;
  }
  return out;
}

function resolveGatewayConfigSchema() {
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      workspaceDir: { type: "string" },
      models: { type: "object", additionalProperties: true },
      gateway: { type: "object", additionalProperties: true },
      channels: { type: "object", additionalProperties: true },
      tools: { type: "object", additionalProperties: true },
      email: { type: "object", additionalProperties: true },
      github: { type: "object", additionalProperties: true },
      providers: { type: "object", additionalProperties: true },
    },
  };
}

function resolveCronTargetSessionId(job, contextSessionId) {
  const explicit = String(job?.sessionId ?? "").trim();
  if (explicit) return explicit;
  const fromJob = String(job?.mainSessionId ?? "").trim();
  if (fromJob) return fromJob;
  return String(contextSessionId ?? "").trim() || "terminal";
}

function normalizeCronJobInput({ job, params, context }) {
  const rawJob = isRecord(job) ? { ...job } : {};
  if (!isRecord(job) || Object.keys(rawJob).length === 0) {
    const keys = [
      "name",
      "schedule",
      "sessionTarget",
      "wakeMode",
      "payload",
      "delivery",
      "enabled",
      "description",
      "deleteAfterRun",
      "agentId",
      "message",
      "text",
      "model",
      "thinking",
      "timeoutSeconds",
      "allowUnsafeExternalContent",
    ];
    for (const key of keys) {
      if (params[key] !== undefined) rawJob[key] = params[key];
    }
  }
  const now = Date.now();
  const id = String(rawJob.id ?? "").trim() || crypto.randomUUID();
  const name = String(rawJob.name ?? "").trim() || "";
  const enabled = rawJob.enabled === undefined ? true : Boolean(rawJob.enabled);
  const schedule = isRecord(rawJob.schedule) ? rawJob.schedule : null;
  const requestedTarget = String(rawJob.sessionTarget ?? "").trim().toLowerCase();
  const sessionTarget = requestedTarget === "main" ? "main" : "isolated";

  let payload = isRecord(rawJob.payload) ? { ...rawJob.payload } : null;
  if (!payload) {
    const msg = String(rawJob.message ?? "").trim();
    const txt = String(rawJob.text ?? "").trim();
    if (sessionTarget === "main" || txt) {
      payload = { kind: "systemEvent", text: txt || msg };
    } else {
      payload = {
        kind: "agentTurn",
        message: msg || txt,
        model: String(rawJob.model ?? "").trim() || undefined,
        thinking: String(rawJob.thinking ?? "").trim() || undefined,
        timeoutSeconds:
          rawJob.timeoutSeconds === undefined || rawJob.timeoutSeconds === null
            ? undefined
            : clampNumber(rawJob.timeoutSeconds, 0, 3600, 0),
      };
    }
  }

  const payloadKind = String(payload?.kind ?? "").trim();
  if (payloadKind === "agentTurn") {
    const msg = String(payload?.message ?? rawJob.message ?? "").trim();
    payload = {
      ...payload,
      kind: "agentTurn",
      message: msg,
      model: String(payload?.model ?? rawJob.model ?? "").trim() || undefined,
      thinking: String(payload?.thinking ?? rawJob.thinking ?? "").trim() || undefined,
      timeoutSeconds:
        payload?.timeoutSeconds === undefined || payload?.timeoutSeconds === null
          ? undefined
          : clampNumber(payload.timeoutSeconds, 0, 3600, 0),
    };
  }
  if (payloadKind === "systemEvent") {
    payload = {
      ...payload,
      kind: "systemEvent",
      text: String(payload?.text ?? rawJob.text ?? rawJob.message ?? "").trim(),
    };
  }

  if (!schedule || !payload || !payload.kind) {
    return { ok: false, error: "job.schedule and job.payload are required" };
  }
  if (sessionTarget === "main" && payload.kind !== "systemEvent") {
    return { ok: false, error: 'sessionTarget="main" requires payload.kind="systemEvent"' };
  }
  if (sessionTarget === "isolated" && payload.kind !== "agentTurn") {
    return { ok: false, error: 'sessionTarget="isolated" requires payload.kind="agentTurn"' };
  }
  if (payload.kind === "agentTurn" && !String(payload.message ?? "").trim()) {
    return { ok: false, error: "payload.message is required for payload.kind=agentTurn" };
  }
  if (payload.kind === "systemEvent" && !String(payload.text ?? "").trim()) {
    return { ok: false, error: "payload.text is required for payload.kind=systemEvent" };
  }

  const nextRunAtMs = enabled ? computeNextRunAtMs(schedule, now - 1) : null;
  if (enabled && !Number.isFinite(Number(nextRunAtMs))) {
    return { ok: false, error: "invalid or unsupported schedule" };
  }
  const cronJob = {
    id,
    name,
    schedule,
    payload,
    sessionTarget,
    enabled,
    deleteAfterRun: Boolean(rawJob.deleteAfterRun),
    delivery: isRecord(rawJob.delivery) ? rawJob.delivery : undefined,
    agentId: String(rawJob.agentId ?? "").trim() || undefined,
    mainSessionId:
      sessionTarget === "main" ? resolveCronTargetSessionId(rawJob, context?.sessionId) : undefined,
