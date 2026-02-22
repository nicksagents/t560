import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveStateDir } from "../config/paths.js";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function pairingDir(env = process.env) {
  return path.join(resolveStateDir(env), "pairing");
}

function allowFromPath(channel, env = process.env) {
  const safe = String(channel ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  return path.join(pairingDir(env), `${safe}-allowFrom.json`);
}

function requestsPath(channel, env = process.env) {
  const safe = String(channel ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  return path.join(pairingDir(env), `${safe}-requests.json`);
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {}
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
}

function normalizeAllowEntry(entry) {
  const raw = String(entry ?? "").trim();
  if (!raw) return "";
  if (raw === "*" || raw.toLowerCase() === "all") return "*";
  const stripped = raw.replace(/^(telegram|tg):/i, "").trim();
  if (!stripped) return "";
  if (stripped.startsWith("@")) return stripped.toLowerCase();
  if (/^\d+$/.test(stripped)) return stripped;
  return stripped.toLowerCase();
}

function codeAlphabet() {
  // Human-friendly: uppercase, no ambiguous chars (0 O 1 I).
  return "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
}

function randomCode(len = 8) {
  const alpha = codeAlphabet();
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += alpha[crypto.randomInt(0, alpha.length)];
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

export function readAllowFromStore(channel, env = process.env) {
  const p = allowFromPath(channel, env);
  const json = readJson(p, { version: 1, allowFrom: [] });
  const list = Array.isArray(json.allowFrom) ? json.allowFrom : [];
  return list.map(normalizeAllowEntry).filter(Boolean);
}

export function addAllowFromStoreEntry({ channel, entry, env = process.env }) {
  const p = allowFromPath(channel, env);
  const current = readAllowFromStore(channel, env);
  const normalized = normalizeAllowEntry(entry);
  if (!normalized || normalized === "*") return { changed: false, allowFrom: current };
  if (current.includes(normalized)) return { changed: false, allowFrom: current };
  const next = [...current, normalized];
  writeJsonAtomic(p, { version: 1, allowFrom: next });
  return { changed: true, allowFrom: next };
}

export function listPairingRequests(channel, env = process.env) {
  const p = requestsPath(channel, env);
  const json = readJson(p, { version: 1, requests: [] });
  const reqs = Array.isArray(json.requests) ? json.requests : [];
  return reqs
    .filter((r) => r && typeof r === "object" && r.code && r.id)
    .map((r) => ({
      id: String(r.id),
      code: String(r.code).toUpperCase(),
      createdAt: String(r.createdAt ?? ""),
      lastSeenAt: String(r.lastSeenAt ?? ""),
      meta: r.meta && typeof r.meta === "object" ? r.meta : undefined,
    }));
}

export function upsertPairingRequest({ channel, id, meta, env = process.env }) {
  const p = requestsPath(channel, env);
  const existing = listPairingRequests(channel, env);
  const normalizedId = String(id ?? "").trim();
  if (!normalizedId) throw new Error("pairing id required");

  const now = nowIso();
  const idx = existing.findIndex((r) => r.id === normalizedId);
  if (idx >= 0) {
    const keep = existing[idx];
    const next = existing.slice();
    next[idx] = { ...keep, lastSeenAt: now, meta: meta && typeof meta === "object" ? meta : keep.meta };
    writeJsonAtomic(p, { version: 1, requests: next });
    return { code: keep.code, created: false };
  }

  const used = new Set(existing.map((r) => r.code));
  let code = "";
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const c = randomCode(8);
    if (!used.has(c)) {
      code = c;
      break;
    }
  }
  if (!code) throw new Error("failed to allocate pairing code");

  const next = [
    ...existing,
    {
      id: normalizedId,
      code,
      createdAt: now,
      lastSeenAt: now,
      meta: meta && typeof meta === "object" ? meta : undefined,
    },
  ];
  writeJsonAtomic(p, { version: 1, requests: next });
  return { code, created: true };
}

export function approvePairingCode({ channel, code, env = process.env }) {
  const p = requestsPath(channel, env);
  const existing = listPairingRequests(channel, env);
  const target = String(code ?? "").trim().toUpperCase();
  if (!target) throw new Error("pairing code required");
  const idx = existing.findIndex((r) => r.code === target);
  if (idx === -1) return null;
  const req = existing[idx];
  const next = existing.slice();
  next.splice(idx, 1);
  writeJsonAtomic(p, { version: 1, requests: next });
  addAllowFromStoreEntry({ channel, entry: req.id, env });
  return req;
}

