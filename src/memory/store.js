total 12
drwxrwxr-x  2 agent_t490 agent_t490 4096 Feb 18 00:31 .
drwxrwxr-x 17 agent_t490 agent_t490 4096 Feb 18 01:31 ..
-rw-rw-r--  1 agent_t490 agent_t490 1996 Feb 18 00:31 store.js
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveStateDir } from "../config/paths.js";

function memoryPath(env = process.env) {
  return path.join(resolveStateDir(env), "memory.jsonl");
}

export function saveMemory(params) {
  const { title, content, tags, env = process.env } = params;
  const p = memoryPath(env);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const entry = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    title: String(title ?? "").trim(),
    content: String(content ?? "").trim(),
    tags: Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean) : [],
  };
  fs.appendFileSync(p, JSON.stringify(entry) + "\n", "utf8");
  try {
    fs.chmodSync(p, 0o600);
  } catch {}
  return entry;
}

export function loadAllMemories(env = process.env) {
  const p = memoryPath(env);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {}
  }
  return out;
}

export function searchMemories(params) {
  const { query, limit = 5, env = process.env } = params;
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return [];
  const all = loadAllMemories(env);
  const scored = [];
  for (const m of all) {
    const hay = `${m.title ?? ""}\n${m.content ?? ""}\n${(m.tags ?? []).join(" ")}`.toLowerCase();
    const idx = hay.indexOf(q);
    if (idx !== -1) {
      scored.push({ score: 1000 - idx, item: m });
      continue;
    }
    // crude token scoring
    const tokens = q.split(/\s+/).filter(Boolean);
    let s = 0;
    for (const t of tokens) if (hay.includes(t)) s += 1;
    if (s > 0) scored.push({ score: s, item: m });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, Number(limit) || 5)).map((x) => x.item);
}

