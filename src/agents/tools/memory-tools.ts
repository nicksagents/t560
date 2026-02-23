import { randomUUID } from "node:crypto";
import { access, appendFile, chmod, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "@mariozechner/pi-ai";
import { isSensitivePath } from "../../security/credentials-vault.js";
import type { AnyAgentTool } from "../pi-tools.types.js";

const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_GET_MAX_CHARS = 12_000;
const DEFAULT_CONTEXT_LINES = 3;
const MAX_MEMORY_FILE_BYTES = 1_000_000;
const MAX_STORE_SCAN = 2_000;
const MAX_FILE_SCAN = 200;
const DEFAULT_IMPORTANCE = 3;
const DEFAULT_CONFIDENCE = 0.8;
const DEFAULT_NAMESPACE = "global";
const DEFAULT_MIN_TRUST_TIER = "unverified";
const TRUST_TIERS = ["unverified", "observed", "verified", "system"] as const;
const VECTOR_DIM = 128;
const DEFAULT_NAMESPACE_MAX_ENTRIES = 2_000;
const DEFAULT_NAMESPACE_MAX_BYTES = 4_000_000;
const EVICTION_POLICIES = ["stale_low_signal", "low_signal_first", "oldest"] as const;
const SURROUNDING_FILENAMES = new Set<string>([
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "README.md",
]);

type MemoryToolOptions = {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
};

type MemoryStoreEntry = {
  id: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  reinforceCount: number;
  title: string;
  content: string;
  tags: string[];
  importance: number;
  confidence: number;
  source: string;
  namespace: string;
  trustTier: MemoryTrustTier;
};

type MemoryStoreDeleteMarker = {
  type: "delete";
  id: string;
  deletedAt: string;
  reason?: string;
};

type StoreSearchHit = {
  kind: "store";
  ref: string;
  id: string;
  title: string;
  preview: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  importance: number;
  confidence: number;
  source: string;
  namespace: string;
  trustTier: MemoryTrustTier;
  score: number;
  exactMatch: boolean;
  matchedTokens: number;
};

type FileSearchHit = {
  kind: "file";
  ref: string;
  path: string;
  line: number;
  preview: string;
  score: number;
  exactMatch: boolean;
  matchedTokens: number;
};

type MemorySearchHit = StoreSearchHit | FileSearchHit;

type MemoryConflictHint = {
  ref: string;
  id: string;
  title: string;
  reason: string;
  similarity: number;
};

type MemoryTrustTier = (typeof TRUST_TIERS)[number];

type MemoryScope = {
  namespace: string;
  minTrustTier: MemoryTrustTier;
};

type MemoryEvictionPolicy = (typeof EVICTION_POLICIES)[number];

type NamespaceQuota = {
  maxEntries: number;
  maxBytes: number;
  evictionPolicy: MemoryEvictionPolicy;
};

type NamespaceQuotaConfig = {
  defaults: NamespaceQuota;
  perNamespace: Record<string, NamespaceQuota>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    const normalized = String(row ?? "").trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= 20) {
      break;
    }
  }
  return out;
}

function normalizeSource(value: unknown, fallback = "user"): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (/^[a-z0-9._/-]{2,32}$/.test(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeNamespace(value: unknown, fallback = DEFAULT_NAMESPACE): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (/^[a-z0-9._/-]{1,64}$/.test(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeTrustTier(value: unknown, fallback: MemoryTrustTier = "verified"): MemoryTrustTier {
  const normalized = String(value ?? "").trim().toLowerCase();
  if ((TRUST_TIERS as readonly string[]).includes(normalized)) {
    return normalized as MemoryTrustTier;
  }
  return fallback;
}

function trustTierRank(value: unknown): number {
  const normalized = normalizeTrustTier(value, "unverified");
  const idx = TRUST_TIERS.indexOf(normalized);
  return idx < 0 ? 0 : idx;
}

function resolveDefaultNamespaceFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeNamespace(env.T560_MEMORY_NAMESPACE, DEFAULT_NAMESPACE);
}

function resolveDefaultMinTrustTierFromEnv(env: NodeJS.ProcessEnv = process.env): MemoryTrustTier {
  return normalizeTrustTier(env.T560_MEMORY_MIN_TRUST_TIER, DEFAULT_MIN_TRUST_TIER as MemoryTrustTier);
}

function normalizeEvictionPolicy(value: unknown, fallback: MemoryEvictionPolicy = "stale_low_signal"): MemoryEvictionPolicy {
  const normalized = String(value ?? "").trim().toLowerCase();
  if ((EVICTION_POLICIES as readonly string[]).includes(normalized)) {
    return normalized as MemoryEvictionPolicy;
  }
  return fallback;
}

function parseNamespaceQuotaValue(raw: unknown, defaults: NamespaceQuota): NamespaceQuota {
  const row = isRecord(raw) ? raw : {};
  return {
    maxEntries: clampInt(row.maxEntries, 1, 100_000, defaults.maxEntries),
    maxBytes: clampInt(row.maxBytes, 8_000, 200_000_000, defaults.maxBytes),
    evictionPolicy: normalizeEvictionPolicy(row.evictionPolicy, defaults.evictionPolicy),
  };
}

function resolveNamespaceQuotaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NamespaceQuotaConfig {
  const defaults: NamespaceQuota = {
    maxEntries: clampInt(env.T560_MEMORY_MAX_ENTRIES, 1, 100_000, DEFAULT_NAMESPACE_MAX_ENTRIES),
    maxBytes: clampInt(env.T560_MEMORY_MAX_BYTES, 8_000, 200_000_000, DEFAULT_NAMESPACE_MAX_BYTES),
    evictionPolicy: normalizeEvictionPolicy(env.T560_MEMORY_EVICTION_POLICY, "stale_low_signal"),
  };

  const perNamespace: Record<string, NamespaceQuota> = {};
  const raw = String(env.T560_MEMORY_NAMESPACE_LIMITS ?? "").trim();
  if (!raw) {
    return { defaults, perNamespace };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return { defaults, perNamespace };
    }
    for (const [namespaceKey, value] of Object.entries(parsed)) {
      const ns = normalizeNamespace(namespaceKey, "");
      if (!ns) {
        continue;
      }
      perNamespace[ns] = parseNamespaceQuotaValue(value, defaults);
    }
  } catch {
    // ignore malformed env JSON and continue with defaults
  }
  return { defaults, perNamespace };
}

function resolveNamespaceQuota(config: NamespaceQuotaConfig, namespace: string): NamespaceQuota {
  return config.perNamespace[namespace] ?? config.defaults;
}

function tokenizeQuery(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/g)
    .map((row) => canonicalizeToken(row.trim()))
    .filter((row) => row.length > 1);
  return Array.from(new Set(tokens)).slice(0, 24);
}

function computeScore(haystack: string, query: string, tokens: string[]): number {
  const source = haystack.toLowerCase();
  let score = 0;
  if (query && source.includes(query)) {
    score += 70;
  }
  for (const token of tokens) {
    if (source.includes(token)) {
      score += 8;
    }
  }
  return score;
}

function countMatchedTokens(haystack: string, tokens: string[]): number {
  const source = haystack.toLowerCase();
  let matched = 0;
  for (const token of tokens) {
    if (source.includes(token)) {
      matched += 1;
    }
  }
  return matched;
}

function clipText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, maxChars)}\n\n[truncated]`, truncated: true };
}

function compactPreview(text: string, maxChars = 280): string {
  const compact = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  if (compact.length <= maxChars) {
    return compact;
  }
  const cut = compact.lastIndexOf(" ", maxChars - 1);
  const end = cut >= Math.floor(maxChars * 0.6) ? cut : maxChars - 1;
  return `${compact.slice(0, end).trim()}...`;
}

function canonicalizeToken(token: string): string {
  const raw = String(token ?? "").trim().toLowerCase();
  if (!raw) {
    return "";
  }
  const aliases: Record<string, string> = {
    automate: "automation",
    automating: "automation",
    automation: "automation",
    deploy: "deployment",
    deploying: "deployment",
    deployment: "deployment",
    auth: "authentication",
    authenticate: "authentication",
    authentication: "authentication",
    prefs: "preference",
    prefer: "preference",
    preferred: "preference",
    like: "preference",
    likes: "preference",
    pipeline: "workflow",
    pipelines: "workflow",
  };
  if (aliases[raw]) {
    return aliases[raw];
  }
  if (raw.endsWith("ing") && raw.length > 5) {
    return raw.slice(0, -3);
  }
  if (raw.endsWith("ed") && raw.length > 4) {
    return raw.slice(0, -2);
  }
  if (raw.endsWith("s") && raw.length > 3) {
    return raw.slice(0, -1);
  }
  return raw;
}

function normalizeTitleKey(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenizeForSimilarity(value: string): Set<string> {
  const tokens = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/g)
    .map((item) => canonicalizeToken(item.trim()))
    .filter((item) => item.length > 2)
    .slice(0, 80);
  return new Set(tokens);
}

function embedTokens(tokens: string[]): Map<number, number> {
  const vec = new Map<number, number>();
  for (const token of tokens) {
    if (!token) {
      continue;
    }
    let hash = 2166136261;
    for (let idx = 0; idx < token.length; idx += 1) {
      hash ^= token.charCodeAt(idx);
      hash = Math.imul(hash, 16777619);
    }
    const bucket = Math.abs(hash) % VECTOR_DIM;
    vec.set(bucket, (vec.get(bucket) ?? 0) + 1);
  }
  return vec;
}

function cosineSimilarity(a: Map<number, number>, b: Map<number, number>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const value of a.values()) {
    normA += value * value;
  }
  for (const value of b.values()) {
    normB += value * value;
  }
  for (const [bucket, valueA] of a.entries()) {
    const valueB = b.get(bucket) ?? 0;
    if (valueB > 0) {
      dot += valueA * valueB;
    }
  }
  if (normA <= 0 || normB <= 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  if (union <= 0) {
    return 0;
  }
  return intersection / union;
}

function mergeMemoryTags(existing: string[], incoming: string[]): string[] {
  return normalizeTags([...existing, ...incoming]);
}

function mergeMemoryContent(existing: string, incoming: string): string {
  const oldText = String(existing ?? "").trim();
  const newText = String(incoming ?? "").trim();
  if (!oldText) {
    return newText;
  }
  if (!newText) {
    return oldText;
  }
  if (oldText === newText) {
    return oldText;
  }
  if (newText.includes(oldText)) {
    return newText;
  }
  if (oldText.includes(newText)) {
    return oldText;
  }
  return `${oldText}\n\nUpdate (${new Date().toISOString().slice(0, 10)}): ${newText}`;
}

function buildPreviewAroundQuery(content: string, query: string): string {
  const compact = String(content ?? "").replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  if (!query) {
    return compactPreview(compact);
  }
  const idx = compact.toLowerCase().indexOf(query);
  if (idx < 0) {
    return compactPreview(compact);
  }
  const start = Math.max(0, idx - 90);
  const end = Math.min(compact.length, idx + Math.max(140, query.length + 90));
  const fragment = compact.slice(start, end);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < compact.length ? "..." : "";
  return `${prefix}${fragment}${suffix}`;
}

function normalizeLineBreaks(text: string): string[] {
  return String(text ?? "").replace(/\r\n/g, "\n").split("\n");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function resolveStateDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const raw = String(env.T560_STATE_DIR ?? "").trim();
  if (!raw) {
    return path.join(os.homedir(), ".t560");
  }
  if (raw === "~") {
    return os.homedir();
  }
  if (raw.startsWith("~/")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return path.resolve(raw);
}

function resolveMemoryStorePath(options: MemoryToolOptions): string {
  const stateRoot = options.stateDir?.trim() || resolveStateDirFromEnv(options.env ?? process.env);
  return path.join(path.resolve(stateRoot), "memory.jsonl");
}

function parseStoreEntry(raw: unknown): MemoryStoreEntry | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = String(raw.id ?? "").trim();
  const title = String(raw.title ?? "").trim();
  const content = String(raw.content ?? "").trim();
  const createdAt = String(raw.createdAt ?? "").trim();
  const updatedAt = String(raw.updatedAt ?? createdAt).trim();
  const lastAccessedAt = String(raw.lastAccessedAt ?? updatedAt ?? createdAt).trim();
  const reinforceCount = clampInt(raw.reinforceCount, 0, 10_000, 0);
  const tags = normalizeTags(raw.tags);
  const importance = clampInt(raw.importance, 1, 5, DEFAULT_IMPORTANCE);
  const confidence = clampNumber(raw.confidence, 0.05, 1, DEFAULT_CONFIDENCE);
  const source = normalizeSource(raw.source, "user");
  const namespace = normalizeNamespace(raw.namespace, DEFAULT_NAMESPACE);
  const trustTier = normalizeTrustTier(raw.trustTier, "verified");
  if (!id || !title || !content || !createdAt) {
    return null;
  }
  return {
    id,
    title,
    content,
    tags,
    createdAt,
    updatedAt: updatedAt || createdAt,
    lastAccessedAt: lastAccessedAt || updatedAt || createdAt,
    reinforceCount,
    importance,
    confidence,
    source,
    namespace,
    trustTier,
  };
}

function parseStoreDeleteMarker(raw: unknown): MemoryStoreDeleteMarker | null {
  if (!isRecord(raw)) {
    return null;
  }
  const type = String(raw.type ?? "").trim().toLowerCase();
  if (type !== "delete") {
    return null;
  }
  const id = String(raw.id ?? "").trim();
  const deletedAt = String(raw.deletedAt ?? "").trim();
  const reason = String(raw.reason ?? "").trim();
  if (!id || !deletedAt) {
    return null;
  }
  return {
    type: "delete",
    id,
    deletedAt,
    ...(reason ? { reason } : {}),
  };
}

async function loadStoreEntries(
  storePath: string,
  options?: {
    maxEntries?: number;
  },
): Promise<MemoryStoreEntry[]> {
  if (!(await pathExists(storePath))) {
    return [];
  }
  const maxEntriesRaw = Number(options?.maxEntries);
  const maxEntries =
    options?.maxEntries === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Number.isFinite(maxEntriesRaw)
    ? Math.max(1, Math.floor(maxEntriesRaw))
    : MAX_STORE_SCAN;
  const raw = await readFile(storePath, "utf-8");
  const lines = normalizeLineBreaks(raw);
  const out: MemoryStoreEntry[] = [];
  const seenIds = new Set<string>();
  const deletedIds = new Set<string>();
  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    const line = lines[idx] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const deleted = parseStoreDeleteMarker(parsed);
      if (deleted) {
        deletedIds.add(deleted.id);
        continue;
      }
      const normalized = parseStoreEntry(parsed);
      if (normalized) {
        if (deletedIds.has(normalized.id)) {
          continue;
        }
        if (seenIds.has(normalized.id)) {
          continue;
        }
        seenIds.add(normalized.id);
        out.push(normalized);
      }
    } catch {
      // Skip malformed lines to preserve forward compatibility.
    }
    if (out.length >= maxEntries) {
      break;
    }
  }
  return out.reverse();
}

function resolveScope(params: {
  namespace?: unknown;
  minTrustTier?: unknown;
  defaults: { namespace: string; minTrustTier: MemoryTrustTier };
}): MemoryScope {
  return {
    namespace: normalizeNamespace(params.namespace, params.defaults.namespace),
    minTrustTier: normalizeTrustTier(params.minTrustTier, params.defaults.minTrustTier),
  };
}

function entryMatchesScope(entry: MemoryStoreEntry, scope: MemoryScope): boolean {
  if (entry.namespace !== scope.namespace) {
    return false;
  }
  return trustTierRank(entry.trustTier) >= trustTierRank(scope.minTrustTier);
}

function estimateEntryBytes(entry: MemoryStoreEntry): number {
  return Buffer.byteLength(`${JSON.stringify(entry)}\n`, "utf-8");
}

function computeEntrySignalScore(entry: MemoryStoreEntry): number {
  const now = Date.now();
  const updatedMs = parseIsoMillis(entry.updatedAt || entry.createdAt);
  const lastAccessMs = parseIsoMillis(entry.lastAccessedAt || entry.updatedAt || entry.createdAt);
  const ageDays = updatedMs > 0 ? Math.max(0, Math.floor((now - updatedMs) / 86_400_000)) : 0;
  const accessAgeDays = lastAccessMs > 0 ? Math.max(0, Math.floor((now - lastAccessMs) / 86_400_000)) : ageDays;
  return (
    entry.importance * 24 +
    entry.confidence * 40 +
    entry.reinforceCount * 4 +
    trustTierRank(entry.trustTier) * 10 -
    ageDays * 0.4 -
    accessAgeDays * 0.6
  );
}

function pickEvictionCandidate(
  entries: MemoryStoreEntry[],
  policy: MemoryEvictionPolicy,
): MemoryStoreEntry | null {
  if (entries.length === 0) {
    return null;
  }
  if (policy === "oldest") {
    return entries
      .slice()
      .sort((a, b) => parseIsoMillis(a.updatedAt || a.createdAt) - parseIsoMillis(b.updatedAt || b.createdAt))[0] ?? null;
  }

  const scored = entries.map((entry) => ({
    entry,
    score: policy === "low_signal_first"
      ? entry.importance * 20 + entry.confidence * 30 + entry.reinforceCount * 5 + trustTierRank(entry.trustTier) * 6
      : computeEntrySignalScore(entry),
    updatedMs: parseIsoMillis(entry.updatedAt || entry.createdAt),
  }));
  scored.sort((a, b) => a.score - b.score || a.updatedMs - b.updatedMs);
  return scored[0]?.entry ?? null;
}

async function enforceNamespaceQuota(params: {
  storePath: string;
  namespace: string;
  quotaConfig: NamespaceQuotaConfig;
  protectedIds?: string[];
}): Promise<{ evictedIds: string[]; quota: NamespaceQuota }> {
  const quota = resolveNamespaceQuota(params.quotaConfig, params.namespace);
  const entries = await loadStoreEntries(params.storePath, { maxEntries: Number.POSITIVE_INFINITY });
  const scoped = entries.filter((entry) => entry.namespace === params.namespace);
  const protectedIds = new Set((params.protectedIds ?? []).filter(Boolean));
  let totalBytes = scoped.reduce((sum, entry) => sum + estimateEntryBytes(entry), 0);
  const evicted: MemoryStoreEntry[] = [];
  const active = [...scoped];
  while (active.length > quota.maxEntries || totalBytes > quota.maxBytes) {
    const candidates = active.filter((entry) => !protectedIds.has(entry.id));
    const victim = pickEvictionCandidate(candidates, quota.evictionPolicy);
    if (!victim) {
      break;
    }
    const idx = active.findIndex((entry) => entry.id === victim.id);
    if (idx < 0) {
      break;
    }
    active.splice(idx, 1);
    totalBytes -= estimateEntryBytes(victim);
    evicted.push(victim);
  }

  if (evicted.length > 0) {
    const deletedAt = new Date().toISOString();
    await appendStoreDeleteMarkers(
      params.storePath,
      evicted.map((entry) => ({
        type: "delete",
        id: entry.id,
        deletedAt,
        reason: `Namespace quota eviction (${quota.evictionPolicy})`,
      })),
    );
  }
  return {
    evictedIds: evicted.map((entry) => entry.id),
    quota,
  };
}

async function findStoreEntryById(
  storePath: string,
  targetId: string,
  scope?: MemoryScope,
): Promise<MemoryStoreEntry | null> {
  if (!(await pathExists(storePath))) {
    return null;
  }
  const raw = await readFile(storePath, "utf-8");
  const lines = normalizeLineBreaks(raw);
  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    const line = lines[idx] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const deleted = parseStoreDeleteMarker(parsed);
      if (deleted && deleted.id === targetId) {
        return null;
      }
      const normalized = parseStoreEntry(parsed);
      if (normalized && normalized.id === targetId) {
        if (scope && !entryMatchesScope(normalized, scope)) {
          return null;
        }
        return normalized;
      }
    } catch {
      // ignore malformed lines
    }
  }
  return null;
}

async function findStoreEntryByTitle(
  storePath: string,
  title: string,
  scope?: MemoryScope,
): Promise<MemoryStoreEntry | null> {
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) {
    return null;
  }
  const entries = await loadStoreEntries(storePath, { maxEntries: Number.POSITIVE_INFINITY });
  const matches = entries.filter((entry) => normalizeTitleKey(entry.title) === titleKey);
  const scoped = scope ? matches.filter((entry) => entryMatchesScope(entry, scope)) : matches;
  if (scoped.length === 0) {
    return null;
  }
  scoped.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return scoped[0] ?? null;
}

async function appendStoreEntry(storePath: string, entry: MemoryStoreEntry): Promise<void> {
  await mkdir(path.dirname(storePath), { recursive: true });
  await appendFile(storePath, `${JSON.stringify(entry)}\n`, "utf-8");
  try {
    await chmod(storePath, 0o600);
  } catch {
    // best effort
  }
}

async function appendStoreDeleteMarker(
  storePath: string,
  marker: MemoryStoreDeleteMarker,
): Promise<void> {
  await mkdir(path.dirname(storePath), { recursive: true });
  await appendFile(storePath, `${JSON.stringify(marker)}\n`, "utf-8");
  try {
    await chmod(storePath, 0o600);
  } catch {
    // best effort
  }
}

async function appendStoreDeleteMarkers(
  storePath: string,
  markers: MemoryStoreDeleteMarker[],
): Promise<void> {
  if (markers.length === 0) {
    return;
  }
  await mkdir(path.dirname(storePath), { recursive: true });
  await appendFile(
    storePath,
    `${markers.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf-8",
  );
  try {
    await chmod(storePath, 0o600);
  } catch {
    // best effort
  }
}

function normalizeRelativePath(workspaceDir: string, targetPath: string): string {
  return path.relative(workspaceDir, targetPath).replace(/\\/g, "/");
}

function isMemoryFilePath(workspaceDir: string, targetPath: string): boolean {
  const absoluteWorkspace = path.resolve(workspaceDir);
  const absoluteTarget = path.resolve(targetPath);
  const relative = normalizeRelativePath(absoluteWorkspace, absoluteTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  const lowered = relative.toLowerCase();
  if (lowered === "memory.md") {
    return true;
  }
  return lowered.startsWith("memory/") && lowered.endsWith(".md");
}

function isSurroundingFilePath(workspaceDir: string, targetPath: string): boolean {
  const absoluteWorkspace = path.resolve(workspaceDir);
  const absoluteTarget = path.resolve(targetPath);
  const relative = normalizeRelativePath(absoluteWorkspace, absoluteTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  if (relative.includes("/")) {
    return false;
  }
  return SURROUNDING_FILENAMES.has(relative);
}

function isMemorySourceFilePath(workspaceDir: string, targetPath: string): boolean {
  return isMemoryFilePath(workspaceDir, targetPath) || isSurroundingFilePath(workspaceDir, targetPath);
}

async function collectMemoryFiles(params: {
  workspaceDir: string;
  includeSurrounding: boolean;
}): Promise<string[]> {
  const workspaceDir = params.workspaceDir;
  const root = path.resolve(workspaceDir);
  const found = new Set<string>();

  const addIfMemoryFile = async (candidate: string): Promise<void> => {
    if (!isMemorySourceFilePath(root, candidate)) {
      return;
    }
    if (isSensitivePath(candidate, root)) {
      return;
    }
    if (!(await pathExists(candidate))) {
      return;
    }
    const info = await stat(candidate);
    if (!info.isFile()) {
      return;
    }
    found.add(path.resolve(candidate));
  };

  await addIfMemoryFile(path.join(root, "MEMORY.md"));
  await addIfMemoryFile(path.join(root, "memory.md"));
  if (params.includeSurrounding) {
    for (const fileName of SURROUNDING_FILENAMES) {
      await addIfMemoryFile(path.join(root, fileName));
    }
  }

  const memoryDir = path.join(root, "memory");
  if (await pathExists(memoryDir)) {
    const stack = [memoryDir];
    while (stack.length > 0 && found.size < MAX_FILE_SCAN) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (found.size >= MAX_FILE_SCAN) {
          break;
        }
        const entryName = String(entry.name ?? "");
        if (!entryName || entryName.startsWith(".")) {
          continue;
        }
        const absolute = path.join(current, entryName);
        if (entry.isDirectory()) {
          stack.push(absolute);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        if (!entryName.toLowerCase().endsWith(".md")) {
          continue;
        }
        await addIfMemoryFile(absolute);
      }
    }
  }

  return Array.from(found).sort((a, b) => a.localeCompare(b));
}

function buildFileContextSnippet(lines: string[], lineIndex: number, contextLines: number): string {
  const start = Math.max(0, lineIndex - contextLines);
  const end = Math.min(lines.length, lineIndex + contextLines + 1);
  const snippet: string[] = [];
  for (let idx = start; idx < end; idx += 1) {
    const lineNo = idx + 1;
    snippet.push(`${lineNo}: ${lines[idx] ?? ""}`);
  }
  return snippet.join("\n").trim();
}

function searchStoreEntries(
  entries: MemoryStoreEntry[],
  query: string,
  tokens: string[],
  queryEmbedding: Map<number, number>,
): StoreSearchHit[] {
  const now = Date.now();
  const results: StoreSearchHit[] = [];
  for (const entry of entries) {
    const haystack = `${entry.title}\n${entry.content}\n${entry.tags.join(" ")}`;
    let score = computeScore(haystack, query, tokens);
    if (score <= 0) {
      continue;
    }
    const exactMatch = query.length > 0 && haystack.toLowerCase().includes(query);
    const matchedTokens = countMatchedTokens(haystack, tokens);
    const updatedAtMs = Number.parseInt(String(Date.parse(entry.updatedAt || entry.createdAt)), 10);
    if (Number.isFinite(updatedAtMs)) {
      const ageDays = Math.max(0, Math.floor((now - updatedAtMs) / 86_400_000));
      score += Math.max(0, 18 - Math.floor(ageDays / 14));
    }
    const accessAtMs = Number.parseInt(String(Date.parse(entry.lastAccessedAt || entry.updatedAt || entry.createdAt)), 10);
    if (Number.isFinite(accessAtMs)) {
      const accessAgeDays = Math.max(0, Math.floor((now - accessAtMs) / 86_400_000));
      score += Math.max(0, 12 - Math.floor(accessAgeDays / 21));
    }
    score += entry.importance * 6;
    score += Math.round(entry.confidence * 10);
    score += Math.min(24, entry.reinforceCount * 3);
    score += trustTierRank(entry.trustTier) * 2;
    const entryEmbedding = embedTokens(Array.from(tokenizeForSimilarity(haystack)));
    const semanticSimilarity = cosineSimilarity(queryEmbedding, entryEmbedding);
    score += Math.round(semanticSimilarity * 30);
    results.push({
      kind: "store",
      ref: `store:${entry.id}`,
      id: entry.id,
      title: entry.title,
      preview: buildPreviewAroundQuery(entry.content, query),
      tags: entry.tags,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      importance: entry.importance,
      confidence: entry.confidence,
      source: entry.source,
      namespace: entry.namespace,
      trustTier: entry.trustTier,
      score,
      exactMatch,
      matchedTokens,
    });
  }
  return results;
}

async function searchMemoryFiles(params: {
  workspaceDir: string;
  query: string;
  tokens: string[];
  includeSurrounding: boolean;
}): Promise<{ hits: FileSearchHit[]; filesScanned: number }> {
  const files = await collectMemoryFiles({
    workspaceDir: params.workspaceDir,
    includeSurrounding: params.includeSurrounding,
  });
  const hits: FileSearchHit[] = [];
  let filesScanned = 0;
  for (const filePath of files) {
    filesScanned += 1;
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(filePath);
    } catch {
      continue;
    }
    if (!info.isFile() || info.size > MAX_MEMORY_FILE_BYTES) {
      continue;
    }

    const text = await readFile(filePath, "utf-8");
    const lines = normalizeLineBreaks(text);
    const perFileMatches: Array<{
      lineIndex: number;
      score: number;
      exactMatch: boolean;
      matchedTokens: number;
    }> = [];
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx] ?? "";
      if (!line.trim()) {
        continue;
      }
      const score = computeScore(line, params.query, params.tokens);
      if (score <= 0) {
        continue;
      }
      const exactMatch = params.query.length > 0 && line.toLowerCase().includes(params.query);
      const matchedTokens = countMatchedTokens(line, params.tokens);
      perFileMatches.push({ lineIndex: idx, score, exactMatch, matchedTokens });
    }
    perFileMatches.sort((a, b) => b.score - a.score || a.lineIndex - b.lineIndex);
    const relativePath = normalizeRelativePath(params.workspaceDir, filePath);
    for (const row of perFileMatches.slice(0, 2)) {
      const line = row.lineIndex + 1;
      hits.push({
        kind: "file",
        ref: `file:${relativePath}#L${line}`,
        path: relativePath,
        line,
        preview: compactPreview(buildFileContextSnippet(lines, row.lineIndex, DEFAULT_CONTEXT_LINES), 320),
        score: row.score + 6,
        exactMatch: row.exactMatch,
        matchedTokens: row.matchedTokens,
      });
    }
  }
  return { hits, filesScanned };
}

function parseFileRef(ref: string): { path: string; line?: number } | null {
  const trimmed = String(ref ?? "").trim();
  if (!trimmed.startsWith("file:")) {
    return null;
  }
  const body = trimmed.slice("file:".length);
  const match = /^(.*?)(?:#L(\d+))?$/.exec(body);
  if (!match) {
    return null;
  }
  const filePath = String(match[1] ?? "").trim();
  if (!filePath) {
    return null;
  }
  const line = match[2] ? clampInt(match[2], 1, 1_000_000, 1) : undefined;
  return { path: filePath, line };
}

function parseIsoMillis(value: string): number {
  const millis = Date.parse(String(value ?? "").trim());
  if (!Number.isFinite(millis)) {
    return 0;
  }
  return millis;
}

function normalizeComparablePhrase(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPreferenceTarget(content: string): string {
  const source = normalizeComparablePhrase(content);
  if (!source) {
    return "";
  }
  const patterns = [
    /\b(?:prefer(?:s|red)?|like(?:s|d)?|love(?:s|d)?|use(?:s|d)?)\s+([^.;\n]{2,120})/,
    /\b(?:switched\s+to|moved\s+to)\s+([^.;\n]{2,120})/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match?.[1]) {
      return normalizeComparablePhrase(match[1]);
    }
  }
  return "";
}

function hasNegativePreferenceSignal(content: string): boolean {
  const source = normalizeComparablePhrase(content);
  return /\b(?:dislike(?:s|d)?|hate(?:s|d)?|avoid(?:s|ed)?|no longer|stopped using|switched from)\b/.test(source);
}

function detectConflictReason(existingContent: string, incomingContent: string): string | null {
  const existing = normalizeComparablePhrase(existingContent);
  const incoming = normalizeComparablePhrase(incomingContent);
  if (!existing || !incoming) {
    return null;
  }
  if (existing === incoming || existing.includes(incoming) || incoming.includes(existing)) {
    return null;
  }

  const existingTarget = extractPreferenceTarget(existing);
  const incomingTarget = extractPreferenceTarget(incoming);
  if (existingTarget && incomingTarget && existingTarget !== incomingTarget) {
    if (existingTarget.includes(incomingTarget) || incomingTarget.includes(existingTarget)) {
      return null;
    }
    const overlap = jaccardSimilarity(tokenizeForSimilarity(existingTarget), tokenizeForSimilarity(incomingTarget));
    if (overlap < 0.75) {
      return `Preference target changed from "${existingTarget}" to "${incomingTarget}".`;
    }
  }

  const oppositePolarity =
    (hasNegativePreferenceSignal(existing) && !hasNegativePreferenceSignal(incoming)) ||
    (!hasNegativePreferenceSignal(existing) && hasNegativePreferenceSignal(incoming));
  if (oppositePolarity) {
    return "Preference polarity appears to have changed (positive vs negative).";
  }

  const overlap = jaccardSimilarity(tokenizeForSimilarity(existing), tokenizeForSimilarity(incoming));
  if (overlap <= 0.25) {
    return "New memory content diverges strongly from the existing entry.";
  }
  return null;
}

function findPotentialConflicts(params: {
  entries: MemoryStoreEntry[];
  title: string;
  content: string;
}): MemoryConflictHint[] {
  const titleKey = normalizeTitleKey(params.title);
  const incomingTokens = tokenizeForSimilarity(`${params.title}\n${params.content}`);
  const hints: MemoryConflictHint[] = [];
  for (const entry of params.entries) {
    const sameTitle = normalizeTitleKey(entry.title) === titleKey;
    const similarity = jaccardSimilarity(incomingTokens, tokenizeForSimilarity(`${entry.title}\n${entry.content}`));
    if (!sameTitle && similarity < 0.65) {
      continue;
    }
    const reason = detectConflictReason(entry.content, params.content);
    if (!reason) {
      continue;
    }
    hints.push({
      ref: `store:${entry.id}`,
      id: entry.id,
      title: entry.title,
      reason,
      similarity: Number(similarity.toFixed(3)),
    });
  }
  hints.sort((a, b) => b.similarity - a.similarity);
  return hints.slice(0, 8);
}

function containsLikelySecret(text: string): boolean {
  const source = String(text ?? "");
  if (!source.trim()) {
    return false;
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(source)) {
    return true;
  }
  if (/\b(?:sk|pk)_[A-Za-z0-9]{16,}\b/.test(source)) {
    return true;
  }
  if (/\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(source)) {
    return true;
  }
  if (/\bAKIA[0-9A-Z]{16}\b/.test(source)) {
    return true;
  }
  if (/\bASIA[0-9A-Z]{16}\b/.test(source)) {
    return true;
  }
  if (/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/.test(source)) {
    return true;
  }
  if (/\bAIza[0-9A-Za-z_\-]{30,}\b/.test(source)) {
    return true;
  }
  if (/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/.test(source)) {
    return true;
  }
  if (/\b[A-Za-z0-9+/_=-]{32,}\b/.test(source) && /\b(secret|token|password|api[-_ ]?key|passcode)\b/i.test(source)) {
    return true;
  }
  return false;
}

function pickStoreEntryForUpsert(
  entries: MemoryStoreEntry[],
  title: string,
  content: string,
): MemoryStoreEntry | null {
  const titleKey = normalizeTitleKey(title);
  if (!titleKey) {
    return null;
  }

  const byTitle = entries.find((entry) => normalizeTitleKey(entry.title) === titleKey);
  if (byTitle) {
    return byTitle;
  }

  const incomingTokens = tokenizeForSimilarity(`${title}\n${content}`);
  if (incomingTokens.size === 0) {
    return null;
  }
  let best: { entry: MemoryStoreEntry; score: number } | null = null;
  for (const entry of entries) {
    const existingTokens = tokenizeForSimilarity(`${entry.title}\n${entry.content}`);
    const score = jaccardSimilarity(incomingTokens, existingTokens);
    if (score < 0.72) {
      continue;
    }
    if (!best || score > best.score) {
      best = { entry, score };
    }
  }
  return best?.entry ?? null;
}

function buildMemoryToolsContext(options: MemoryToolOptions): {
  workspaceDir: string;
  storePath: string;
  defaultNamespace: string;
  defaultMinTrustTier: MemoryTrustTier;
  quotaConfig: NamespaceQuotaConfig;
} {
  const workspaceDir = path.resolve(options.workspaceDir);
  const storePath = resolveMemoryStorePath(options);
  const env = options.env ?? process.env;
  return {
    workspaceDir,
    storePath,
    defaultNamespace: resolveDefaultNamespaceFromEnv(env),
    defaultMinTrustTier: resolveDefaultMinTrustTierFromEnv(env),
    quotaConfig: resolveNamespaceQuotaConfigFromEnv(env),
  };
}

export function createMemorySearchTool(options: MemoryToolOptions): AnyAgentTool {
  const ctx = buildMemoryToolsContext(options);
  return {
    name: "memory_search",
    description:
      "Search long-term memory (saved entries plus MEMORY.md/memory/*.md) for prior decisions, preferences, and context.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query for prior context or preferences." }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
      includeStore: Type.Optional(Type.Boolean({ default: true })),
      includeFiles: Type.Optional(Type.Boolean({ default: true })),
      namespace: Type.Optional(Type.String({ description: "Memory namespace (user/workspace scope)." })),
      minTrustTier: Type.Optional(Type.String({ description: "Minimum trust tier: unverified, observed, verified, system." })),
      includeSurrounding: Type.Optional(
        Type.Boolean({ description: "Include workspace context files (AGENTS.md, USER.md, README.md, etc.).", default: true }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const query = String(params.query ?? "").trim().toLowerCase();
      if (!query) {
        throw new Error("query is required.");
      }
      const limit = clampInt(params.limit, 1, 20, DEFAULT_SEARCH_LIMIT);
      const includeStore = params.includeStore !== false;
      const includeFiles = params.includeFiles !== false;
      const includeSurrounding = includeFiles && params.includeSurrounding !== false;
      const tokens = tokenizeQuery(query);
      const queryEmbedding = embedTokens(tokens);
      const scope = resolveScope({
        namespace: params.namespace,
        minTrustTier: params.minTrustTier,
        defaults: {
          namespace: ctx.defaultNamespace,
          minTrustTier: ctx.defaultMinTrustTier,
        },
      });

      const allHits: MemorySearchHit[] = [];
      let storeScanned = 0;
      let filesScanned = 0;

      if (includeStore) {
        const entries = await loadStoreEntries(ctx.storePath);
        const scopedEntries = entries.filter((entry) => entryMatchesScope(entry, scope));
        storeScanned = entries.length;
        allHits.push(...searchStoreEntries(scopedEntries, query, tokens, queryEmbedding));
      }
      if (includeFiles) {
        const fileSearch = await searchMemoryFiles({
          workspaceDir: ctx.workspaceDir,
          query,
          tokens,
          includeSurrounding,
        });
        filesScanned = fileSearch.filesScanned;
        allHits.push(...fileSearch.hits);
      }

      allHits.sort((a, b) => b.score - a.score);
      return {
        query,
        limit,
        results: allHits.slice(0, limit),
        searched: {
          includeStore,
          includeFiles,
          includeSurrounding,
          namespace: scope.namespace,
          minTrustTier: scope.minTrustTier,
          storeEntriesScanned: storeScanned,
          storeEntriesMatchedScope: includeStore ? allHits.filter((row) => row.kind === "store").length : 0,
          filesScanned,
        },
      };
    },
  };
}

export function createMemoryGetTool(options: MemoryToolOptions): AnyAgentTool {
  const ctx = buildMemoryToolsContext(options);
  return {
    name: "memory_get",
    description: "Retrieve an exact memory entry or source snippet by ref/id/path (for precise recall).",
    parameters: Type.Object({
      ref: Type.Optional(Type.String({ description: "Reference returned by memory_search." })),
      id: Type.Optional(Type.String({ description: "Store entry id (or store:<id>)."})),
      path: Type.Optional(Type.String({ description: "Memory file path relative to workspace (MEMORY.md or memory/*.md)." })),
      namespace: Type.Optional(Type.String({ description: "Memory namespace scope when reading store entries." })),
      minTrustTier: Type.Optional(Type.String({ description: "Minimum trust tier for store entry reads." })),
      reinforce: Type.Optional(Type.Boolean({ description: "When true (default), reinforce store entries upon successful recall." })),
      line: Type.Optional(Type.Number({ minimum: 1 })),
      contextLines: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
      maxChars: Type.Optional(Type.Number({ minimum: 200, maximum: 60_000 })),
    }),
    execute: async (_toolCallId, params) => {
      const contextLines = clampInt(params.contextLines, 0, 20, DEFAULT_CONTEXT_LINES);
      const maxChars = clampInt(params.maxChars, 200, 60_000, DEFAULT_GET_MAX_CHARS);
      const reinforce = params.reinforce !== false;
      const scope = resolveScope({
        namespace: params.namespace,
        minTrustTier: params.minTrustTier,
        defaults: {
          namespace: ctx.defaultNamespace,
          minTrustTier: ctx.defaultMinTrustTier,
        },
      });

      const ref = String(params.ref ?? "").trim();
      const explicitId = String(params.id ?? "").trim();
      const idFromRef = ref.startsWith("store:") ? ref.slice("store:".length).trim() : "";
      const targetId = explicitId.startsWith("store:") ? explicitId.slice("store:".length).trim() : (explicitId || idFromRef);
      if (targetId) {
        const entry = await findStoreEntryById(ctx.storePath, targetId, scope);
        if (!entry) {
          throw new Error(`Memory entry not found: ${targetId}`);
        }
        const now = new Date().toISOString();
        const materialized = reinforce
          ? {
              ...entry,
              updatedAt: now,
              lastAccessedAt: now,
              reinforceCount: Math.min(10_000, entry.reinforceCount + 1),
              confidence: clampNumber(entry.confidence + 0.02, 0.05, 1, entry.confidence),
            }
          : entry;
        if (reinforce) {
          await appendStoreEntry(ctx.storePath, materialized);
        }
        const clipped = clipText(entry.content, maxChars);
        return {
          source: "store",
          ref: `store:${entry.id}`,
          id: entry.id,
          title: entry.title,
          content: clipped.text,
          truncated: clipped.truncated,
          tags: entry.tags,
          createdAt: entry.createdAt,
          updatedAt: materialized.updatedAt,
          lastAccessedAt: materialized.lastAccessedAt,
          reinforceCount: materialized.reinforceCount,
          importance: materialized.importance,
          confidence: materialized.confidence,
          memorySource: materialized.source,
          namespace: materialized.namespace,
          trustTier: materialized.trustTier,
          reinforced: reinforce,
        };
      }

      const pathFromRef = parseFileRef(ref);
      const rawPath = String(params.path ?? pathFromRef?.path ?? "").trim();
      const line = clampInt(params.line ?? pathFromRef?.line, 1, 1_000_000, 1);
      if (!rawPath) {
        throw new Error("Provide one of: ref, id, or path.");
      }

      const absolutePath = path.resolve(ctx.workspaceDir, rawPath);
      if (!isMemorySourceFilePath(ctx.workspaceDir, absolutePath)) {
        throw new Error(
          "memory_get path must target memory docs (MEMORY.md, memory.md, memory/*.md) or surrounding context files (AGENTS.md, USER.md, SOUL.md, TOOLS.md, IDENTITY.md, HEARTBEAT.md, BOOTSTRAP.md, README.md).",
        );
      }
      if (isSensitivePath(absolutePath, ctx.workspaceDir)) {
        throw new Error("Access to sensitive credential files is blocked.");
      }
      if (!(await pathExists(absolutePath))) {
        throw new Error(`Memory file not found: ${rawPath}`);
      }
      const text = await readFile(absolutePath, "utf-8");
      const lines = normalizeLineBreaks(text);
      const lineIndex = Math.max(0, Math.min(lines.length - 1, line - 1));
      const snippet = buildFileContextSnippet(lines, lineIndex, contextLines);
      const clipped = clipText(snippet, maxChars);
      const relativePath = normalizeRelativePath(ctx.workspaceDir, absolutePath);
      const start = Math.max(1, lineIndex + 1 - contextLines);
      const end = Math.min(lines.length, lineIndex + 1 + contextLines);
      return {
        source: "file",
        ref: `file:${relativePath}#L${lineIndex + 1}`,
        path: relativePath,
        lineStart: start,
        lineEnd: end,
        content: clipped.text,
        truncated: clipped.truncated,
      };
    },
  };
}

export function createMemorySaveTool(options: MemoryToolOptions): AnyAgentTool {
  const ctx = buildMemoryToolsContext(options);
  const validConflictStrategies = new Set(["upsert", "replace"]);
  return {
    name: "memory_save",
    description: "Save durable, non-secret memory items (preferences, decisions, recurring procedures).",
    parameters: Type.Object({
      title: Type.String({ description: "Short memory title." }),
      content: Type.String({ description: "Durable memory content to remember." }),
      tags: Type.Optional(Type.Array(Type.String())),
      importance: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
      confidence: Type.Optional(Type.Number({ minimum: 0.05, maximum: 1 })),
      source: Type.Optional(Type.String({ description: "Memory source label (for example: user, inferred, system)." })),
      namespace: Type.Optional(Type.String({ description: "Memory namespace (user/workspace scope)." })),
      trustTier: Type.Optional(Type.String({ description: "Trust tier: unverified, observed, verified, system." })),
      onConflict: Type.Optional(
        Type.String({ description: "Conflict strategy when contradictory memory is detected: upsert (default) or replace." }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const title = String(params.title ?? "").trim();
      const content = String(params.content ?? "").trim();
      const tags = normalizeTags(params.tags);
      const importance = clampInt(params.importance, 1, 5, DEFAULT_IMPORTANCE);
      const confidence = clampNumber(params.confidence, 0.05, 1, DEFAULT_CONFIDENCE);
      const source = normalizeSource(params.source, "user");
      const namespace = normalizeNamespace(params.namespace, ctx.defaultNamespace);
      let trustTier = normalizeTrustTier(params.trustTier, source === "user" ? "verified" : "observed");
      if (source !== "system" && trustTier === "system") {
        trustTier = "verified";
      }
      const onConflict = String(params.onConflict ?? "upsert").trim().toLowerCase() || "upsert";
      if (!title) {
        throw new Error("title is required.");
      }
      if (!content) {
        throw new Error("content is required.");
      }
      if (!validConflictStrategies.has(onConflict)) {
        throw new Error("onConflict must be one of: upsert, replace.");
      }
      if (containsLikelySecret(`${title}\n${content}\n${tags.join(" ")}`)) {
        throw new Error("memory_save blocked: suspected secret/credential content. Do not store secrets in memory.");
      }

      const now = new Date().toISOString();
      const entries = await loadStoreEntries(ctx.storePath, { maxEntries: Number.POSITIVE_INFINITY });
      const scopedEntries = entries.filter((entry) => entry.namespace === namespace);
      const existing = pickStoreEntryForUpsert(scopedEntries, title, content);
      const conflicts = findPotentialConflicts({ entries: scopedEntries, title, content });
      const conflictIds = Array.from(new Set(conflicts.map((row) => row.id)));
      const shouldReplaceConflicts = onConflict === "replace" && conflictIds.length > 0;

      if (shouldReplaceConflicts) {
        await appendStoreDeleteMarkers(
          ctx.storePath,
          conflictIds.map((id) => ({
            type: "delete",
            id,
            deletedAt: now,
            reason: `Replaced by newer conflicting memory for "${title}"`,
          })),
        );
      }

      const entry: MemoryStoreEntry = shouldReplaceConflicts
        ? {
            id: randomUUID(),
            title,
            content,
            tags,
            createdAt: now,
            updatedAt: now,
            lastAccessedAt: now,
            reinforceCount: 0,
            importance,
            confidence,
            source,
            namespace,
            trustTier,
          }
        : {
            id: existing?.id ?? randomUUID(),
            title,
            content: existing ? mergeMemoryContent(existing.content, content) : content,
            tags: existing ? mergeMemoryTags(existing.tags, tags) : tags,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            lastAccessedAt: existing?.lastAccessedAt ?? now,
            reinforceCount: existing?.reinforceCount ?? 0,
            importance: existing ? Math.max(existing.importance, importance) : importance,
            confidence: existing
              ? clampNumber((existing.confidence + confidence) / 2 + 0.05, 0.05, 1, confidence)
              : confidence,
            source: existing ? (source === "user" ? existing.source : source) : source,
            namespace: existing?.namespace ?? namespace,
            trustTier: existing
              ? (trustTierRank(existing.trustTier) >= trustTierRank(trustTier) ? existing.trustTier : trustTier)
              : trustTier,
          };
      await appendStoreEntry(ctx.storePath, entry);
      const quotaOutcome = await enforceNamespaceQuota({
        storePath: ctx.storePath,
        namespace: entry.namespace,
        quotaConfig: ctx.quotaConfig,
        protectedIds: [entry.id],
      });
      return {
        ok: true,
        ref: `store:${entry.id}`,
        id: entry.id,
        title: entry.title,
        tags: entry.tags,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        importance: entry.importance,
        confidence: entry.confidence,
        memorySource: entry.source,
        namespace: entry.namespace,
        trustTier: entry.trustTier,
        onConflict,
        upserted: Boolean(existing && !shouldReplaceConflicts),
        conflictDetected: conflicts.length > 0,
        conflicts,
        replacedIds: shouldReplaceConflicts ? conflictIds : [],
        quota: {
          namespace: entry.namespace,
          ...quotaOutcome.quota,
        },
        evictedIds: quotaOutcome.evictedIds,
        ...(conflicts.length > 0 && !shouldReplaceConflicts
          ? { conflictSuggestion: "Potential contradiction detected. Use onConflict='replace' to supersede older entry." }
          : {}),
      };
    },
  };
}

export function createMemoryDeleteTool(options: MemoryToolOptions): AnyAgentTool {
  const ctx = buildMemoryToolsContext(options);
  return {
    name: "memory_delete",
    description: "Delete a durable memory entry by ref/id/title when it is outdated, incorrect, or no longer wanted.",
    parameters: Type.Object({
      ref: Type.Optional(Type.String({ description: "Store ref returned by memory_search (store:<id>)." })),
      id: Type.Optional(Type.String({ description: "Store entry id (or store:<id>)."})),
      title: Type.Optional(Type.String({ description: "Exact memory title (case-insensitive) to delete." })),
      reason: Type.Optional(Type.String({ description: "Optional short reason for deletion." })),
      namespace: Type.Optional(Type.String({ description: "Memory namespace scope for deletion." })),
      minTrustTier: Type.Optional(Type.String({ description: "Minimum trust tier scope for deletion." })),
    }),
    execute: async (_toolCallId, params) => {
      const ref = String(params.ref ?? "").trim();
      const explicitId = String(params.id ?? "").trim();
      const title = String(params.title ?? "").trim();
      const reason = String(params.reason ?? "").trim();
      const scope = resolveScope({
        namespace: params.namespace,
        minTrustTier: params.minTrustTier,
        defaults: {
          namespace: ctx.defaultNamespace,
          minTrustTier: ctx.defaultMinTrustTier,
        },
      });

      if (ref.startsWith("file:")) {
        throw new Error("memory_delete only supports durable store entries (store:<id>), not file refs.");
      }

      const idFromRef = ref.startsWith("store:") ? ref.slice("store:".length).trim() : "";
      const targetId = explicitId.startsWith("store:") ? explicitId.slice("store:".length).trim() : (explicitId || idFromRef);

      let entry: MemoryStoreEntry | null = null;
      if (targetId) {
        entry = await findStoreEntryById(ctx.storePath, targetId, scope);
      } else if (title) {
        entry = await findStoreEntryByTitle(ctx.storePath, title, scope);
      } else {
        throw new Error("Provide one of: ref, id, or title.");
      }

      if (!entry) {
        throw new Error("Memory entry not found or already deleted.");
      }

      const deletedAt = new Date().toISOString();
      await appendStoreDeleteMarker(ctx.storePath, {
        type: "delete",
        id: entry.id,
        deletedAt,
        ...(reason ? { reason } : {}),
      });

      return {
        ok: true,
        deleted: true,
        ref: `store:${entry.id}`,
        id: entry.id,
        title: entry.title,
        namespace: entry.namespace,
        trustTier: entry.trustTier,
        deletedAt,
        ...(reason ? { reason } : {}),
      };
    },
  };
}

export function createMemoryListTool(options: MemoryToolOptions): AnyAgentTool {
  const ctx = buildMemoryToolsContext(options);
  const validOrders = new Set(["updated_desc", "updated_asc", "created_desc", "created_asc"]);
  return {
    name: "memory_list",
    description: "List durable memory entries with optional filtering by query/tags and deterministic ordering.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Optional search query to filter entries." })),
      tags: Type.Optional(Type.Array(Type.String({ description: "Optional tag filter (all tags must match)." }))),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
      importanceAtLeast: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
      source: Type.Optional(Type.String({ description: "Optional memory source filter (exact, case-insensitive)." })),
      namespace: Type.Optional(Type.String({ description: "Memory namespace scope." })),
      minTrustTier: Type.Optional(Type.String({ description: "Minimum trust tier: unverified, observed, verified, system." })),
      order: Type.Optional(
        Type.String({ description: "Sort order: updated_desc, updated_asc, created_desc, created_asc." }),
      ),
      includeContent: Type.Optional(Type.Boolean({ default: false })),
      maxContentChars: Type.Optional(Type.Number({ minimum: 200, maximum: 60_000 })),
    }),
    execute: async (_toolCallId, params) => {
      const query = String(params.query ?? "").trim().toLowerCase();
      const tokens = tokenizeQuery(query);
      const tags = normalizeTags(params.tags);
      const limit = clampInt(params.limit, 1, 500, 50);
      const importanceAtLeast = clampInt(params.importanceAtLeast, 1, 5, 1);
      const sourceFilter = normalizeSource(params.source, "");
      const scope = resolveScope({
        namespace: params.namespace,
        minTrustTier: params.minTrustTier,
        defaults: {
          namespace: ctx.defaultNamespace,
          minTrustTier: ctx.defaultMinTrustTier,
        },
      });
      const includeContent = params.includeContent === true;
      const maxContentChars = clampInt(params.maxContentChars, 200, 60_000, DEFAULT_GET_MAX_CHARS);
      const order = String(params.order ?? "updated_desc").trim().toLowerCase();
      if (!validOrders.has(order)) {
        throw new Error("order must be one of: updated_desc, updated_asc, created_desc, created_asc.");
      }

      const scanned = await loadStoreEntries(ctx.storePath, { maxEntries: Number.POSITIVE_INFINITY });
      const filtered = scanned.filter((entry) => {
        if (!entryMatchesScope(entry, scope)) {
          return false;
        }
        if (tags.length > 0 && !tags.every((tag) => entry.tags.includes(tag))) {
          return false;
        }
        if (entry.importance < importanceAtLeast) {
          return false;
        }
        if (sourceFilter && entry.source !== sourceFilter) {
          return false;
        }
        if (!query) {
          return true;
        }
        const haystack = `${entry.title}\n${entry.content}\n${entry.tags.join(" ")}`;
        return computeScore(haystack, query, tokens) > 0;
      });

      filtered.sort((a, b) => {
        if (order === "updated_asc") {
          return parseIsoMillis(a.updatedAt) - parseIsoMillis(b.updatedAt);
        }
        if (order === "created_desc") {
          return parseIsoMillis(b.createdAt) - parseIsoMillis(a.createdAt);
        }
        if (order === "created_asc") {
          return parseIsoMillis(a.createdAt) - parseIsoMillis(b.createdAt);
        }
        return parseIsoMillis(b.updatedAt) - parseIsoMillis(a.updatedAt);
      });

      const rows = filtered.slice(0, limit).map((entry) => {
        const clipped = clipText(entry.content, maxContentChars);
        return {
          ref: `store:${entry.id}`,
          id: entry.id,
          title: entry.title,
          preview: compactPreview(entry.content, 240),
          tags: entry.tags,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          lastAccessedAt: entry.lastAccessedAt,
          reinforceCount: entry.reinforceCount,
          importance: entry.importance,
          confidence: entry.confidence,
          memorySource: entry.source,
          namespace: entry.namespace,
          trustTier: entry.trustTier,
          ...(includeContent ? { content: clipped.text, truncated: clipped.truncated } : {}),
        };
      });

      return {
        limit,
        total: filtered.length,
        scanned: scanned.length,
        results: rows,
        filters: {
          query: query || null,
          tags,
          importanceAtLeast,
          source: sourceFilter || null,
          namespace: scope.namespace,
          minTrustTier: scope.minTrustTier,
          order,
          includeContent,
        },
      };
    },
  };
}

export function createMemoryPruneTool(options: MemoryToolOptions): AnyAgentTool {
  const ctx = buildMemoryToolsContext(options);
  return {
    name: "memory_prune",
    description:
      "Prune stale memory entries by retention policy (count/age). Dry-run by default for safe review before applying.",
    parameters: Type.Object({
      maxEntries: Type.Optional(Type.Number({ minimum: 1, maximum: 10_000 })),
      olderThanDays: Type.Optional(Type.Number({ minimum: 1, maximum: 3_650 })),
      dryRun: Type.Optional(Type.Boolean({ default: true })),
      reason: Type.Optional(Type.String({ description: "Optional reason attached to generated delete markers." })),
      namespace: Type.Optional(Type.String({ description: "Memory namespace scope for pruning." })),
      minTrustTier: Type.Optional(Type.String({ description: "Minimum trust tier scope for pruning." })),
    }),
    execute: async (_toolCallId, params) => {
      const hasMaxEntries = Number.isFinite(Number(params.maxEntries));
      const hasOlderThanDays = Number.isFinite(Number(params.olderThanDays));
      if (!hasMaxEntries && !hasOlderThanDays) {
        throw new Error("Provide at least one prune criterion: maxEntries or olderThanDays.");
      }

      const maxEntries = hasMaxEntries ? clampInt(params.maxEntries, 1, 10_000, 1_000) : null;
      const olderThanDays = hasOlderThanDays ? clampInt(params.olderThanDays, 1, 3_650, 365) : null;
      const dryRun = params.dryRun !== false;
      const reason = String(params.reason ?? "").trim() || "Pruned by retention policy";
      const scope = resolveScope({
        namespace: params.namespace,
        minTrustTier: params.minTrustTier,
        defaults: {
          namespace: ctx.defaultNamespace,
          minTrustTier: ctx.defaultMinTrustTier,
        },
      });

      const entries = await loadStoreEntries(ctx.storePath, { maxEntries: Number.POSITIVE_INFINITY });
      const sorted = entries
        .filter((entry) => entryMatchesScope(entry, scope))
        .sort((a, b) => parseIsoMillis(b.updatedAt) - parseIsoMillis(a.updatedAt));
      const thresholdMs = olderThanDays ? Date.now() - olderThanDays * 86_400_000 : null;
      const pruneCandidates = sorted.filter((entry, idx) => {
        const overCountLimit = maxEntries !== null && idx >= maxEntries;
        const updatedMs = parseIsoMillis(entry.updatedAt || entry.createdAt);
        const overAgeLimit = thresholdMs !== null && updatedMs > 0 && updatedMs <= thresholdMs;
        return overCountLimit || overAgeLimit;
      });

      if (!dryRun && pruneCandidates.length > 0) {
        const deletedAt = new Date().toISOString();
        await appendStoreDeleteMarkers(
          ctx.storePath,
          pruneCandidates.map((entry) => ({
            type: "delete",
            id: entry.id,
            deletedAt,
            reason,
          })),
        );
      }

      return {
        ok: true,
        dryRun,
        scanned: sorted.length,
        kept: Math.max(0, sorted.length - pruneCandidates.length),
        pruned: dryRun ? 0 : pruneCandidates.length,
        wouldPrune: pruneCandidates.length,
        criteria: {
          ...(maxEntries !== null ? { maxEntries } : {}),
          ...(olderThanDays !== null ? { olderThanDays } : {}),
          namespace: scope.namespace,
          minTrustTier: scope.minTrustTier,
        },
        reason,
        samples: pruneCandidates.slice(0, 25).map((entry) => ({
          ref: `store:${entry.id}`,
          id: entry.id,
          title: entry.title,
          updatedAt: entry.updatedAt,
        })),
      };
    },
  };
}

export function createMemoryStatsTool(options: MemoryToolOptions): AnyAgentTool {
  const ctx = buildMemoryToolsContext(options);
  return {
    name: "memory_stats",
    description:
      "Report memory quality and storage analytics (per-namespace counts, trust mix, reinforcement, stale candidates).",
    parameters: Type.Object({
      namespace: Type.Optional(Type.String({ description: "Optional namespace filter." })),
      minTrustTier: Type.Optional(Type.String({ description: "Minimum trust tier filter." })),
      includeStaleCandidates: Type.Optional(Type.Boolean({ default: true })),
      staleLimit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
      limitNamespaces: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
    }),
    execute: async (_toolCallId, params) => {
      const scope = resolveScope({
        namespace: params.namespace,
        minTrustTier: params.minTrustTier,
        defaults: {
          namespace: params.namespace ? normalizeNamespace(params.namespace, ctx.defaultNamespace) : "",
          minTrustTier: ctx.defaultMinTrustTier,
        },
      });
      const includeStaleCandidates = params.includeStaleCandidates !== false;
      const staleLimit = clampInt(params.staleLimit, 1, 50, 12);
      const limitNamespaces = clampInt(params.limitNamespaces, 1, 200, 40);
      const rawStore = (await pathExists(ctx.storePath)) ? await readFile(ctx.storePath, "utf-8") : "";
      const historyLines = normalizeLineBreaks(rawStore).filter((line) => line.trim().length > 0).length;
      const activeEntries = await loadStoreEntries(ctx.storePath, { maxEntries: Number.POSITIVE_INFINITY });

      const filtered = activeEntries.filter((entry) => {
        if (params.namespace) {
          if (entry.namespace !== scope.namespace) {
            return false;
          }
        }
        return trustTierRank(entry.trustTier) >= trustTierRank(scope.minTrustTier);
      });

      const namespaces = new Map<string, MemoryStoreEntry[]>();
      for (const entry of filtered) {
        if (!namespaces.has(entry.namespace)) {
          namespaces.set(entry.namespace, []);
        }
        namespaces.get(entry.namespace)?.push(entry);
      }

      const namespaceRows = Array.from(namespaces.entries())
        .map(([namespace, entries]) => {
          const bytes = entries.reduce((sum, row) => sum + estimateEntryBytes(row), 0);
          const importanceAvg = entries.reduce((sum, row) => sum + row.importance, 0) / Math.max(1, entries.length);
          const confidenceAvg = entries.reduce((sum, row) => sum + row.confidence, 0) / Math.max(1, entries.length);
          const reinforceAvg = entries.reduce((sum, row) => sum + row.reinforceCount, 0) / Math.max(1, entries.length);
          const trustCounts: Record<string, number> = {
            unverified: 0,
            observed: 0,
            verified: 0,
            system: 0,
          };
          for (const row of entries) {
            trustCounts[row.trustTier] += 1;
          }
          const newestUpdatedAt = entries
            .slice()
            .sort((a, b) => parseIsoMillis(b.updatedAt) - parseIsoMillis(a.updatedAt))[0]?.updatedAt ?? null;
          const oldestUpdatedAt = entries
            .slice()
            .sort((a, b) => parseIsoMillis(a.updatedAt) - parseIsoMillis(b.updatedAt))[0]?.updatedAt ?? null;
          const quota = resolveNamespaceQuota(ctx.quotaConfig, namespace);
          return {
            namespace,
            count: entries.length,
            bytes,
            avgImportance: Number(importanceAvg.toFixed(2)),
            avgConfidence: Number(confidenceAvg.toFixed(3)),
            avgReinforceCount: Number(reinforceAvg.toFixed(2)),
            trustCounts,
            newestUpdatedAt,
            oldestUpdatedAt,
            quota,
          };
        })
        .sort((a, b) => b.count - a.count || b.bytes - a.bytes)
        .slice(0, limitNamespaces);

      const staleCandidates = includeStaleCandidates
        ? filtered
            .slice()
            .sort((a, b) => computeEntrySignalScore(a) - computeEntrySignalScore(b))
            .slice(0, staleLimit)
            .map((entry) => ({
              ref: `store:${entry.id}`,
              id: entry.id,
              title: entry.title,
              namespace: entry.namespace,
              trustTier: entry.trustTier,
              importance: entry.importance,
              confidence: entry.confidence,
              reinforceCount: entry.reinforceCount,
              lastAccessedAt: entry.lastAccessedAt,
              updatedAt: entry.updatedAt,
              score: Number(computeEntrySignalScore(entry).toFixed(3)),
            }))
        : [];

      return {
        ok: true,
        storePath: ctx.storePath,
        totals: {
          activeEntries: activeEntries.length,
          filteredEntries: filtered.length,
          namespaces: namespaces.size,
          historyLines,
          reclaimedLinesPotential: Math.max(0, historyLines - activeEntries.length),
          estimatedActiveBytes: filtered.reduce((sum, entry) => sum + estimateEntryBytes(entry), 0),
        },
        filters: {
          namespace: params.namespace ? scope.namespace : null,
          minTrustTier: scope.minTrustTier,
          includeStaleCandidates,
        },
        namespaces: namespaceRows,
        staleCandidates,
      };
    },
  };
}

export function createMemoryFeedbackTool(options: MemoryToolOptions): AnyAgentTool {
  const ctx = buildMemoryToolsContext(options);
  return {
    name: "memory_feedback",
    description: "Apply usefulness feedback to memory entries to reinforce or down-rank future retrieval.",
    parameters: Type.Object({
      ref: Type.Optional(Type.String({ description: "Store ref (store:<id>) from memory_search." })),
      id: Type.Optional(Type.String({ description: "Store entry id (or store:<id>)." })),
      signal: Type.String({ description: "Feedback signal: useful or not_useful." }),
      weight: Type.Optional(Type.Number({ minimum: 1, maximum: 3 })),
      note: Type.Optional(Type.String({ description: "Optional short feedback note." })),
      namespace: Type.Optional(Type.String({ description: "Memory namespace scope for feedback." })),
      minTrustTier: Type.Optional(Type.String({ description: "Minimum trust tier scope for feedback." })),
    }),
    execute: async (_toolCallId, params) => {
      const ref = String(params.ref ?? "").trim();
      const explicitId = String(params.id ?? "").trim();
      const signal = String(params.signal ?? "").trim().toLowerCase();
      const weight = clampInt(params.weight, 1, 3, 1);
      const note = String(params.note ?? "").trim();
      const scope = resolveScope({
        namespace: params.namespace,
        minTrustTier: params.minTrustTier,
        defaults: {
          namespace: ctx.defaultNamespace,
          minTrustTier: ctx.defaultMinTrustTier,
        },
      });
      if (signal !== "useful" && signal !== "not_useful") {
        throw new Error("signal must be one of: useful, not_useful.");
      }

      const idFromRef = ref.startsWith("store:") ? ref.slice("store:".length).trim() : "";
      const targetId = explicitId.startsWith("store:") ? explicitId.slice("store:".length).trim() : (explicitId || idFromRef);
      if (!targetId) {
        throw new Error("Provide one of: ref or id.");
      }

      const entry = await findStoreEntryById(ctx.storePath, targetId, scope);
      if (!entry) {
        throw new Error(`Memory entry not found: ${targetId}`);
      }

      const now = new Date().toISOString();
      const updated: MemoryStoreEntry = signal === "useful"
        ? {
            ...entry,
            updatedAt: now,
            lastAccessedAt: now,
            reinforceCount: Math.min(10_000, entry.reinforceCount + weight),
            importance: clampInt(entry.importance + weight, 1, 5, entry.importance),
            confidence: clampNumber(entry.confidence + 0.07 * weight, 0.05, 1, entry.confidence),
          }
        : {
            ...entry,
            updatedAt: now,
            lastAccessedAt: now,
            reinforceCount: Math.max(0, entry.reinforceCount - weight),
            importance: clampInt(entry.importance - weight, 1, 5, entry.importance),
            confidence: clampNumber(entry.confidence - 0.08 * weight, 0.05, 1, entry.confidence),
          };

      await appendStoreEntry(ctx.storePath, updated);
      return {
        ok: true,
        ref: `store:${updated.id}`,
        id: updated.id,
        title: updated.title,
        signal,
        weight,
        note: note || null,
        updatedAt: updated.updatedAt,
        lastAccessedAt: updated.lastAccessedAt,
        reinforceCount: updated.reinforceCount,
        importance: updated.importance,
        confidence: updated.confidence,
      };
    },
  };
}

export function createMemoryCompactTool(options: MemoryToolOptions): AnyAgentTool {
  const ctx = buildMemoryToolsContext(options);
  return {
    name: "memory_compact",
    description:
      "Compact memory.jsonl by removing superseded/deleted history lines and keeping only current active entries. Dry-run by default.",
    parameters: Type.Object({
      dryRun: Type.Optional(Type.Boolean({ default: true })),
      namespace: Type.Optional(Type.String({ description: "Optional namespace context label for compaction reports." })),
      minTrustTier: Type.Optional(Type.String({ description: "Optional trust scope label for compaction reports." })),
    }),
    execute: async (_toolCallId, params) => {
      const dryRun = params.dryRun !== false;
      const scope = resolveScope({
        namespace: params.namespace,
        minTrustTier: params.minTrustTier,
        defaults: {
          namespace: ctx.defaultNamespace,
          minTrustTier: ctx.defaultMinTrustTier,
        },
      });
      if (!(await pathExists(ctx.storePath))) {
        return {
          ok: true,
          dryRun,
          compacted: false,
          storePath: ctx.storePath,
          linesBefore: 0,
          linesAfter: 0,
          reclaimedLines: 0,
          bytesBefore: 0,
          bytesAfter: 0,
          scope,
        };
      }

      const raw = await readFile(ctx.storePath, "utf-8");
      const linesBefore = normalizeLineBreaks(raw).filter((line) => line.trim().length > 0).length;
      const bytesBefore = Buffer.byteLength(raw, "utf-8");
      const activeEntries = await loadStoreEntries(ctx.storePath, { maxEntries: Number.POSITIVE_INFINITY });
      const compactBody = activeEntries.map((entry) => JSON.stringify(entry)).join("\n");
      const serialized = compactBody ? `${compactBody}\n` : "";
      const linesAfter = activeEntries.length;
      const bytesAfter = Buffer.byteLength(serialized, "utf-8");

      if (!dryRun) {
        await mkdir(path.dirname(ctx.storePath), { recursive: true });
        const tempPath = `${ctx.storePath}.tmp-${Date.now()}-${randomUUID().slice(0, 8)}`;
        await writeFile(tempPath, serialized, "utf-8");
        try {
          await chmod(tempPath, 0o600);
        } catch {
          // best effort
        }
        await rename(tempPath, ctx.storePath);
        try {
          await chmod(ctx.storePath, 0o600);
        } catch {
          // best effort
        }
      }

      return {
        ok: true,
        dryRun,
        compacted: !dryRun && linesAfter !== linesBefore,
        storePath: ctx.storePath,
        linesBefore,
        linesAfter,
        reclaimedLines: Math.max(0, linesBefore - linesAfter),
        bytesBefore,
        bytesAfter,
        scope,
      };
    },
  };
}
