import { readFile } from "node:fs/promises";
import path from "node:path";

export const T560_BOOTSTRAP_FILENAMES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md"
] as const;

export const DEFAULT_BOOTSTRAP_MAX_CHARS = 20_000;

export type InjectedContextSource = "workspace" | "fallback:soul" | "fallback:user" | "missing";

export type InjectedContextFile = {
  name: string;
  path: string;
  content: string;
  missing: boolean;
  truncated: boolean;
  source: InjectedContextSource;
  rawChars: number;
  injectedChars: number;
};

type FallbackProfileFile = {
  path: string;
  content?: string;
};

function normalizeMaxChars(value: number | undefined): number {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_BOOTSTRAP_MAX_CHARS;
  }
  return Math.max(500, Math.floor(raw));
}

async function readText(filePath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return raw.trim() ? raw : undefined;
  } catch {
    return undefined;
  }
}

function truncateForPrompt(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { content, truncated: false };
  }
  return {
    content:
      content.slice(0, maxChars) +
      `\n\n[TRUNCATED: file exceeds ${maxChars} characters; remaining content omitted]`,
    truncated: true
  };
}

export async function loadT560BootstrapContext(params: {
  workspaceDir: string;
  maxChars?: number;
  soulFallback?: FallbackProfileFile;
  userFallback?: FallbackProfileFile;
}): Promise<InjectedContextFile[]> {
  const workspaceDir = path.resolve(params.workspaceDir);
  const maxChars = normalizeMaxChars(params.maxChars);
  const out: InjectedContextFile[] = [];

  for (const name of T560_BOOTSTRAP_FILENAMES) {
    const workspacePath = path.join(workspaceDir, name);
    const workspaceContent = await readText(workspacePath);
    let sourcePath = workspacePath;
    let content = workspaceContent;
    let source: InjectedContextSource = workspaceContent ? "workspace" : "missing";

    if (!content && name === "SOUL.md" && params.soulFallback?.content) {
      sourcePath = params.soulFallback.path;
      content = params.soulFallback.content;
      source = "fallback:soul";
    }
    if (!content && name === "USER.md" && params.userFallback?.content) {
      sourcePath = params.userFallback.path;
      content = params.userFallback.content;
      source = "fallback:user";
    }

    if (!content) {
      out.push({
        name,
        path: sourcePath,
        content: "(missing file)",
        missing: true,
        truncated: false,
        source: "missing",
        rawChars: 0,
        injectedChars: 0
      });
      continue;
    }

    const normalized = truncateForPrompt(content, maxChars);
    out.push({
      name,
      path: sourcePath,
      content: normalized.content,
      missing: false,
      truncated: normalized.truncated,
      source,
      rawChars: content.length,
      injectedChars: normalized.content.length
    });
  }

  return out;
}
