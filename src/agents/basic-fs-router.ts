import os from "node:os";
import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { getArtifactState } from "./artifact-memory.js";

export type FsRouterPlan = {
  planLines: string[];
  commands: Array<{ command: string }>;
  summary: string;
  includeStdout?: boolean;
  includeStderr?: boolean;
};

const DESKTOP_TYPO = /\bdesk(top|top)\b|\bdestop\b/;
const HOME_TOKENS = /\bhome\b/;
const QUOTED_TEXT = /"([^"]+)"|'([^']+)'/;
const ABS_PATH = /(?:~\/|\/)[^\s"'<>|;]+/g;
const REL_PATH = /(?:\.\.?\/)[^\s"'<>|;]+/g;
const CODE_BLOCK = /```(?:bash|sh|shell)?\s*([\s\S]*?)```/i;
const INLINE_CODE = /`([^`]+)`/;

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function resolvePath(raw: string, baseDir: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
  return path.resolve(baseDir, trimmed);
}

function resolveBaseDir(message: string, fallback: string): string {
  const lower = message.toLowerCase();
  if (DESKTOP_TYPO.test(lower) || lower.includes("desktop")) {
    return path.join(os.homedir(), "Desktop");
  }
  if (HOME_TOKENS.test(lower)) {
    return os.homedir();
  }
  return fallback;
}

function extractQuotedText(message: string): string | null {
  const match = message.match(QUOTED_TEXT);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function extractCommandFromMessage(message: string): string | null {
  const block = message.match(CODE_BLOCK);
  if (block?.[1]) {
    return block[1].trim();
  }
  const inline = message.match(INLINE_CODE);
  if (inline?.[1]) {
    return inline[1].trim();
  }
  const lower = message.toLowerCase().trim();
  const prefixes = ["run ", "execute ", "cmd ", "command ", "terminal "];
  for (const prefix of prefixes) {
    if (lower.startsWith(prefix)) {
      return message.slice(prefix.length).trim();
    }
  }
  return null;
}

function extractFilenames(message: string): string[] {
  const matches = message.match(/[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8}/g);
  return matches ? Array.from(new Set(matches)) : [];
}

function extractPaths(message: string): string[] {
  const abs = message.match(ABS_PATH) ?? [];
  const rel = message.match(REL_PATH) ?? [];
  const combined = [...abs, ...rel];
  return Array.from(new Set(combined));
}

function pickRecentByKeyword(recent: string[], keyword: string): string | undefined {
  const lower = keyword.toLowerCase();
  return recent.find((item) => path.basename(item).toLowerCase().includes(lower));
}

function chooseUniqueFilename(baseName: string, dir: string): string {
  const ext = path.extname(baseName);
  const stem = ext ? baseName.slice(0, -ext.length) : baseName;
  let candidate = baseName;
  let counter = 2;
  while (existsSync(path.join(dir, candidate))) {
    candidate = `${stem}_${counter}${ext}`;
    counter += 1;
  }
  return candidate;
}

function existsDir(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function commandWantsOutput(command: string): boolean {
  const lower = command.trim().toLowerCase();
  return (
    lower.startsWith("ls") ||
    lower.startsWith("cat") ||
    lower.startsWith("rg") ||
    lower.startsWith("grep") ||
    lower.startsWith("pwd") ||
    lower.startsWith("whoami") ||
    lower.startsWith("git status") ||
    lower.startsWith("git diff") ||
    lower.startsWith("git log")
  );
}
function createFilePlan(params: {
  message: string;
  dir: string;
}): FsRouterPlan {
  const lower = params.message.toLowerCase();
  const explicit = extractFilenames(params.message)[0];
  let filename = explicit ?? (lower.includes("greeting") ? "greeting_from_t560.txt" : "desktop_test_file.txt");

  if (lower.includes("new") && !explicit) {
    filename = chooseUniqueFilename(filename, params.dir);
  } else if (!explicit && existsSync(path.join(params.dir, filename))) {
    filename = chooseUniqueFilename(filename, params.dir);
  }

  const quoted = extractQuotedText(params.message);
  let content = quoted ?? "";
  if (!content) {
    if (/(say|says|saying)\s+hello/.test(lower) || lower.includes("hello")) {
      content = "hello";
    } else if (lower.includes("greeting")) {
      content = "Hello Nick! Greetings from T560.";
    } else {
      content = "Test file created by T560.";
    }
  }

  const absPath = path.join(params.dir, filename);
  const cmd = [
    `cd ${shQuote(params.dir)}`,
    `printf %s\\\\n ${shQuote(content)} > ${shQuote(filename)}`,
    `ls -la ${shQuote(filename)}`
  ].join(" && ");

  return {
    planLines: ["Create the requested file.", "Verify it exists and report the path."],
    commands: [{ command: cmd }],
    summary: `Created ${absPath} and verified it exists.`
  };
}

function createFolderPlan(params: {
  message: string;
  dir: string;
}): FsRouterPlan {
  const folderMatch = params.message.match(/(?:folder|directory)\s+(?:named|called)\s+([A-Za-z0-9._-]+)/i);
  const explicitFolder = folderMatch?.[1];
  let folderName = explicitFolder ?? "t560_test_folder";
  if (!explicitFolder && existsSync(path.join(params.dir, folderName))) {
    folderName = chooseUniqueFilename(folderName, params.dir);
  }

  const absFolder = path.join(params.dir, folderName);
  const cmd = [
    `cd ${shQuote(params.dir)}`,
    `mkdir -p ${shQuote(folderName)}`,
    `ls -la ${shQuote(folderName)}`
  ].join(" && ");

  return {
    planLines: ["Create the folder.", "Verify it exists."],
    commands: [{ command: cmd }],
    summary: `Created ${absFolder} and verified it exists.`
  };
}

function createFolderWithFilePlan(params: {
  message: string;
  dir: string;
}): FsRouterPlan {
  const lower = params.message.toLowerCase();
  const folderMatch = params.message.match(/(?:folder|directory)\s+(?:named|called)\s+([A-Za-z0-9._-]+)/i);
  const explicitFolder = folderMatch?.[1];
  let folderName = explicitFolder ?? "t560_test_folder";
  if (!explicitFolder && existsSync(path.join(params.dir, folderName))) {
    folderName = chooseUniqueFilename(folderName, params.dir);
  }

  const fileMatch = params.message.match(/(?:file|txt)\s+(?:named|called)\s+([A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8})/i);
  const fileName = fileMatch?.[1] ?? "status.txt";
  const content = "Folder test successful.";

  const absFolder = path.join(params.dir, folderName);
  const absFile = path.join(absFolder, fileName);
  const cmd = [
    `cd ${shQuote(params.dir)}`,
    `mkdir -p ${shQuote(folderName)}`,
    `printf %s\\\\n ${shQuote(content)} > ${shQuote(path.join(folderName, fileName))}`,
    `ls -la ${shQuote(path.join(folderName, fileName))}`
  ].join(" && ");

  return {
    planLines: ["Create the folder and file on the Desktop.", "Verify the file exists."],
    commands: [{ command: cmd }],
    summary: `Created ${absFile} and verified it exists.`
  };
}

function listDirectoryPlan(params: {
  message: string;
  dir: string;
}): FsRouterPlan {
  const paths = extractPaths(params.message);
  const target = paths.length > 0 ? resolvePath(paths[0], params.dir) : params.dir;
  const cmd = `ls -la ${shQuote(target)}`;
  return {
    planLines: ["List items in the requested directory.", "Report what was found."],
    commands: [{ command: cmd }],
    summary: `Listed items in ${target}.`,
    includeStdout: true
  };
}

function readFilePlan(params: {
  message: string;
  dir: string;
  recent: string[];
  state: ReturnType<typeof getArtifactState>;
}): FsRouterPlan | null {
  const paths = extractPaths(params.message);
  let target = paths.length > 0 ? resolvePath(paths[0], params.dir) : null;
  if (!target) {
    const explicit = extractFilenames(params.message)[0];
    if (explicit) {
      target = path.join(params.dir, explicit);
    }
  }
  if (!target && /that file|the file you created|same file|open it|read it/.test(params.message.toLowerCase())) {
    target = params.state?.lastCreated ?? params.state?.lastTouched ?? params.recent[0];
  }
  if (!target) return null;

  const cmd = `cat ${shQuote(target)}`;
  return {
    planLines: ["Read the requested file.", "Return its contents."],
    commands: [{ command: cmd }],
    summary: `Read ${target}.`,
    includeStdout: true
  };
}

