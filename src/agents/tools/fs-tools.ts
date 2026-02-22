import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@mariozechner/pi-ai";
import type { AnyAgentTool } from "../pi-tools.types.js";

const EDITABLE_START_MARKER = "T560_EDITABLE_START";
const EDITABLE_END_MARKER = "T560_EDITABLE_END";

type EditableRange = {
  start: number;
  end: number;
};

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseEditableRanges(content: string): EditableRange[] {
  const ranges: EditableRange[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    const startMarker = content.indexOf(EDITABLE_START_MARKER, cursor);
    if (startMarker < 0) {
      break;
    }
    const startLineBreak = content.indexOf("\n", startMarker);
    const editableStart = startLineBreak >= 0 ? startLineBreak + 1 : content.length;
    const endMarker = content.indexOf(EDITABLE_END_MARKER, editableStart);
    if (endMarker < 0) {
      break;
    }
    ranges.push({ start: editableStart, end: endMarker });
    cursor = endMarker + EDITABLE_END_MARKER.length;
  }

  return ranges;
}

function isWithinEditableRanges(ranges: EditableRange[], start: number, end: number): boolean {
  return ranges.some((range) => start >= range.start && end <= range.end);
}

function collectMatchRanges(content: string, needle: string): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor <= content.length) {
    const idx = content.indexOf(needle, cursor);
    if (idx < 0) {
      break;
    }
    matches.push({ start: idx, end: idx + needle.length });
    cursor = idx + needle.length;
  }
  return matches;
}

function projectNonEditableContent(content: string, ranges: EditableRange[]): string {
  if (ranges.length === 0) {
    return content;
  }
  let cursor = 0;
  const chunks: string[] = [];
  for (const range of ranges) {
    chunks.push(content.slice(cursor, range.start));
    cursor = range.end;
  }
  chunks.push(content.slice(cursor));
  return chunks.join("");
}

function assertEditWithinAllowedRanges(content: string, findText: string, replaceAll: boolean): void {
  const ranges = parseEditableRanges(content);
  if (ranges.length === 0) {
    return;
  }

  const matches = collectMatchRanges(content, findText);
  if (matches.length === 0) {
    return;
  }

  const targets = replaceAll ? matches : [matches[0]];
  for (const match of targets) {
    if (!isWithinEditableRanges(ranges, match.start, match.end)) {
      throw new Error(
        `Edit blocked: file has editable-region markers (${EDITABLE_START_MARKER}/${EDITABLE_END_MARKER}) and this change touches protected content.`
      );
    }
  }
}

function assertWriteWithinAllowedRanges(existingContent: string, nextContent: string): void {
  const beforeRanges = parseEditableRanges(existingContent);
  if (beforeRanges.length === 0) {
    return;
  }
  const afterRanges = parseEditableRanges(nextContent);
  if (afterRanges.length === 0) {
    throw new Error(
      `Write blocked: files with ${EDITABLE_START_MARKER}/${EDITABLE_END_MARKER} must preserve markers and only change text between them.`
    );
  }

  const beforeProtected = projectNonEditableContent(existingContent, beforeRanges);
  const afterProtected = projectNonEditableContent(nextContent, afterRanges);
  if (beforeProtected !== afterProtected) {
    throw new Error(
      `Write blocked: only content between ${EDITABLE_START_MARKER}/${EDITABLE_END_MARKER} can change.`
    );
  }
}

function resolveToolPath(rawPath: string, workspaceDir: string, workspaceOnly: boolean): string {
  const input = rawPath.trim();
  if (!input) {
    throw new Error("Path is required.");
  }

  const resolved = path.resolve(workspaceDir, input);
  if (workspaceOnly && !isPathInside(workspaceDir, resolved)) {
    throw new Error(`Path '${input}' is outside workspace root.`);
  }

  return resolved;
}

async function walkFiles(basePath: string, limit: number, acc: string[]): Promise<void> {
  if (acc.length >= limit) {
    return;
  }

  const entries = await readdir(basePath, { withFileTypes: true });
  for (const entry of entries) {
    if (acc.length >= limit) {
      return;
    }

    const fullPath = path.join(basePath, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(fullPath, limit, acc);
      continue;
    }

    if (entry.isFile()) {
      acc.push(fullPath);
    }
  }
}

export function createFilesystemTools(options: {
  workspaceDir: string;
  workspaceOnly: boolean;
}): AnyAgentTool[] {
  const workspaceDir = path.resolve(options.workspaceDir);
  const workspaceOnly = options.workspaceOnly;

  const readTool: AnyAgentTool = {
    name: "read",
    description: "Read file contents from disk.",
    parameters: Type.Object({
      path: Type.String({ description: "File path to read." }),
      maxBytes: Type.Optional(Type.Number({ minimum: 1, maximum: 2_000_000 }))
    }),
    execute: async (_toolCallId, params) => {
      const targetPath = resolveToolPath(String(params.path ?? ""), workspaceDir, workspaceOnly);
      const maxBytes = Number(params.maxBytes ?? 250_000);
      const content = await readFile(targetPath, "utf-8");
      if (content.length > maxBytes) {
        return {
          path: targetPath,
          truncated: true,
          content: content.slice(0, maxBytes)
        };
      }

      return {
        path: targetPath,
        truncated: false,
        content
      };
    }
  };

  const writeTool: AnyAgentTool = {
    name: "write",
    description: "Write or overwrite a file on disk.",
    parameters: Type.Object({
      path: Type.String({ description: "File path to write." }),
      content: Type.String({ description: "Full content to write." }),
      createDirs: Type.Optional(Type.Boolean({ default: true }))
    }),
    execute: async (_toolCallId, params) => {
      const targetPath = resolveToolPath(String(params.path ?? ""), workspaceDir, workspaceOnly);
      const content = String(params.content ?? "");
      const createDirs = params.createDirs !== false;

      let existingContent: string | null = null;
      try {
        existingContent = await readFile(targetPath, "utf-8");
      } catch {
        existingContent = null;
      }

      if (existingContent !== null) {
        assertWriteWithinAllowedRanges(existingContent, content);
      }

      if (createDirs) {
        await mkdir(path.dirname(targetPath), { recursive: true });
      }

      await writeFile(targetPath, content, "utf-8");
      return {
        path: targetPath,
        bytes: Buffer.byteLength(content, "utf-8")
      };
    }
  };

  const editTool: AnyAgentTool = {
    name: "edit",
    description: "Find and replace text in a file.",
    parameters: Type.Object({
      path: Type.String({ description: "File path to edit." }),
      find: Type.String({ description: "Text to find." }),
      replace: Type.String({ description: "Replacement text." }),
      replaceAll: Type.Optional(Type.Boolean({ default: false }))
    }),
    execute: async (_toolCallId, params) => {
      const targetPath = resolveToolPath(String(params.path ?? ""), workspaceDir, workspaceOnly);
      const findText = String(params.find ?? "");
      const replaceText = String(params.replace ?? "");
      const replaceAll = Boolean(params.replaceAll);

      if (!findText) {
        throw new Error("find must not be empty.");
      }

      const content = await readFile(targetPath, "utf-8");
      if (!content.includes(findText)) {
        throw new Error("find text was not found in target file.");
      }
      assertEditWithinAllowedRanges(content, findText, replaceAll);

      const next = replaceAll
        ? content.split(findText).join(replaceText)
        : content.replace(findText, replaceText);

      await writeFile(targetPath, next, "utf-8");
      return {
        path: targetPath,
        replaceAll,
        changed: true
      };
    }
  };

  const lsTool: AnyAgentTool = {
    name: "ls",
    description: "List directory contents.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory path to list." })),
      includeHidden: Type.Optional(Type.Boolean({ default: false }))
    }),
    execute: async (_toolCallId, params) => {
      const rootPath = resolveToolPath(String(params.path ?? "."), workspaceDir, workspaceOnly);
      const entries = await readdir(rootPath, { withFileTypes: true });
      const includeHidden = Boolean(params.includeHidden);

      const items = entries
        .filter((entry) => includeHidden || !entry.name.startsWith("."))
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other"
        }));

      return {
        path: rootPath,
        items
      };
    }
  };

  const findTool: AnyAgentTool = {
    name: "find",
    description: "Find files by glob-like substring matching.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory root to scan." })),
      pattern: Type.Optional(Type.String({ description: "Substring to match in file path." })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 5000, default: 200 }))
    }),
    execute: async (_toolCallId, params) => {
      const rootPath = resolveToolPath(String(params.path ?? "."), workspaceDir, workspaceOnly);
      const rootStats = await stat(rootPath);
      if (!rootStats.isDirectory()) {
        throw new Error("find path must be a directory.");
      }

      const limit = Number(params.limit ?? 200);
      const pattern = String(params.pattern ?? "").toLowerCase();
      const scanned: string[] = [];
      await walkFiles(rootPath, limit * 5, scanned);

      const matched = scanned
        .filter((file) => (pattern ? file.toLowerCase().includes(pattern) : true))
        .slice(0, limit)
        .map((filePath) => path.relative(workspaceDir, filePath) || filePath);

      return {
        path: rootPath,
        count: matched.length,
        files: matched
      };
    }
  };

  const existsTool: AnyAgentTool = {
    name: "exists",
    description: "Check if a file or directory exists.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to check." })
    }),
    execute: async (_toolCallId, params) => {
      const targetPath = resolveToolPath(String(params.path ?? ""), workspaceDir, workspaceOnly);
      try {
        await access(targetPath);
        return { path: targetPath, exists: true };
      } catch {
        return { path: targetPath, exists: false };
      }
    }
  };

  return [readTool, writeTool, editTool, lsTool, findTool, existsTool];
}
