import { randomUUID } from "node:crypto";
import { access, appendFile, chmod, mkdir, readdir, readFile, stat } from "node:fs/promises";
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

type MemoryToolOptions = {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
};

type MemoryStoreEntry = {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  content: string;
  tags: string[];
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
  score: number;
};

type FileSearchHit = {
  kind: "file";
  ref: string;
  path: string;
  line: number;
  preview: string;
  score: number;
};

type MemorySearchHit = StoreSearchHit | FileSearchHit;

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

function tokenizeQuery(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/g)
    .map((row) => row.trim())
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
  const tags = normalizeTags(raw.tags);
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
  };
}

async function loadStoreEntries(storePath: string): Promise<MemoryStoreEntry[]> {
  if (!(await pathExists(storePath))) {
    return [];
  }
  const raw = await readFile(storePath, "utf-8");
  const lines = normalizeLineBreaks(raw);
  const out: MemoryStoreEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const normalized = parseStoreEntry(parsed);
      if (normalized) {
        out.push(normalized);
      }
    } catch {
      // Skip malformed lines to preserve forward compatibility.
    }
    if (out.length >= MAX_STORE_SCAN) {
      break;
    }
  }
  return out;
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

async function collectMemoryFiles(workspaceDir: string): Promise<string[]> {
  const root = path.resolve(workspaceDir);
  const found = new Set<string>();

  const addIfMemoryFile = async (candidate: string): Promise<void> => {
    if (!isMemoryFilePath(root, candidate)) {
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

function searchStoreEntries(entries: MemoryStoreEntry[], query: string, tokens: string[]): StoreSearchHit[] {
  const now = Date.now();
  const results: StoreSearchHit[] = [];
  for (const entry of entries) {
    const haystack = `${entry.title}\n${entry.content}\n${entry.tags.join(" ")}`;
    let score = computeScore(haystack, query, tokens);
    if (score <= 0) {
      continue;
    }
    const createdAtMs = Number.parseInt(String(Date.parse(entry.createdAt)), 10);
    if (Number.isFinite(createdAtMs)) {
      const ageDays = Math.max(0, Math.floor((now - createdAtMs) / 86_400_000));
      score += Math.max(0, 18 - Math.floor(ageDays / 14));
    }
    results.push({
      kind: "store",
      ref: `store:${entry.id}`,
      id: entry.id,
      title: entry.title,
      preview: buildPreviewAroundQuery(entry.content, query),
      tags: entry.tags,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      score,
    });
  }
  return results;
}

async function searchMemoryFiles(params: {
  workspaceDir: string;
  query: string;
  tokens: string[];
}): Promise<{ hits: FileSearchHit[]; filesScanned: number }> {
  const files = await collectMemoryFiles(params.workspaceDir);
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
    const perFileMatches: Array<{ lineIndex: number; score: number }> = [];
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx] ?? "";
      if (!line.trim()) {
        continue;
      }
      const score = computeScore(line, params.query, params.tokens);
      if (score <= 0) {
        continue;
      }
      perFileMatches.push({ lineIndex: idx, score });
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
  if (/\b[A-Za-z0-9+/_=-]{32,}\b/.test(source) && /\b(secret|token|password|api[-_ ]?key|passcode)\b/i.test(source)) {
    return true;
  }
  return false;
}

function buildMemoryToolsContext(options: MemoryToolOptions): {
  workspaceDir: string;
  storePath: string;
} {
  const workspaceDir = path.resolve(options.workspaceDir);
  const storePath = resolveMemoryStorePath(options);
  return { workspaceDir, storePath };
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
    }),
    execute: async (_toolCallId, params) => {
      const query = String(params.query ?? "").trim().toLowerCase();
      if (!query) {
        throw new Error("query is required.");
      }
      const limit = clampInt(params.limit, 1, 20, DEFAULT_SEARCH_LIMIT);
      const includeStore = params.includeStore !== false;
      const includeFiles = params.includeFiles !== false;
      const tokens = tokenizeQuery(query);

      const allHits: MemorySearchHit[] = [];
      let storeScanned = 0;
      let filesScanned = 0;

      if (includeStore) {
        const entries = await loadStoreEntries(ctx.storePath);
        storeScanned = entries.length;
        allHits.push(...searchStoreEntries(entries, query, tokens));
      }
      if (includeFiles) {
        const fileSearch = await searchMemoryFiles({
          workspaceDir: ctx.workspaceDir,
          query,
          tokens,
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
          storeEntriesScanned: storeScanned,
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
      line: Type.Optional(Type.Number({ minimum: 1 })),
      contextLines: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
      maxChars: Type.Optional(Type.Number({ minimum: 200, maximum: 60_000 })),
    }),
    execute: async (_toolCallId, params) => {
      const contextLines = clampInt(params.contextLines, 0, 20, DEFAULT_CONTEXT_LINES);
      const maxChars = clampInt(params.maxChars, 200, 60_000, DEFAULT_GET_MAX_CHARS);

      const ref = String(params.ref ?? "").trim();
      const explicitId = String(params.id ?? "").trim();
      const idFromRef = ref.startsWith("store:") ? ref.slice("store:".length).trim() : "";
      const targetId = explicitId.startsWith("store:") ? explicitId.slice("store:".length).trim() : (explicitId || idFromRef);
      if (targetId) {
        const entries = await loadStoreEntries(ctx.storePath);
        const entry = entries.find((row) => row.id === targetId);
        if (!entry) {
          throw new Error(`Memory entry not found: ${targetId}`);
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
          updatedAt: entry.updatedAt,
        };
      }

      const pathFromRef = parseFileRef(ref);
      const rawPath = String(params.path ?? pathFromRef?.path ?? "").trim();
      const line = clampInt(params.line ?? pathFromRef?.line, 1, 1_000_000, 1);
      if (!rawPath) {
        throw new Error("Provide one of: ref, id, or path.");
      }

      const absolutePath = path.resolve(ctx.workspaceDir, rawPath);
      if (!isMemoryFilePath(ctx.workspaceDir, absolutePath)) {
        throw new Error("memory_get path must target MEMORY.md, memory.md, or memory/*.md.");
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
  return {
    name: "memory_save",
    description: "Save durable, non-secret memory items (preferences, decisions, recurring procedures).",
    parameters: Type.Object({
      title: Type.String({ description: "Short memory title." }),
      content: Type.String({ description: "Durable memory content to remember." }),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async (_toolCallId, params) => {
      const title = String(params.title ?? "").trim();
      const content = String(params.content ?? "").trim();
      const tags = normalizeTags(params.tags);
      if (!title) {
        throw new Error("title is required.");
      }
      if (!content) {
        throw new Error("content is required.");
      }
      if (containsLikelySecret(`${title}\n${content}\n${tags.join(" ")}`)) {
        throw new Error("memory_save blocked: suspected secret/credential content. Do not store secrets in memory.");
      }

      const now = new Date().toISOString();
      const entry: MemoryStoreEntry = {
        id: randomUUID(),
        title,
        content,
        tags,
        createdAt: now,
        updatedAt: now,
      };
      await appendStoreEntry(ctx.storePath, entry);
      return {
        ok: true,
        ref: `store:${entry.id}`,
        id: entry.id,
        title: entry.title,
        tags: entry.tags,
        createdAt: entry.createdAt,
      };
    },
  };
}
