import os from "node:os";
import path from "node:path";
import type { T560Config } from "../config/state.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";

export const DEFAULT_SELF_PROTECTED_PATHS = [
  ".",
  "src/cli",
  "dist/cli",
  "cli",
  "src/bin",
  "dist/bin",
  "bin"
];

export type ProtectedPathEntry = {
  raw: string;
  absolute: string;
};

export type SelfProtectionPolicy = {
  enabled: boolean;
  installRoot: string;
  protectedPaths: ProtectedPathEntry[];
};

type TokenPath = {
  raw: string;
  absolute: string;
  wildcard: boolean;
};

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function expandHome(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function resolvePathFromBase(raw: string, baseDir: string): string {
  const expanded = expandHome(raw);
  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  return path.resolve(baseDir, expanded);
}

function dedupeProtectedPaths(entries: ProtectedPathEntry[]): ProtectedPathEntry[] {
  const seen = new Set<string>();
  const out: ProtectedPathEntry[] = [];
  for (const entry of entries) {
    const key = path.resolve(entry.absolute);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ raw: entry.raw, absolute: key });
  }
  return out;
}

function containsWildcard(raw: string): boolean {
  return /[*?\[\]{}]/.test(raw);
}

function splitShellSegments(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      current += ch;
      escaped = true;
      continue;
    }

    if (quote) {
      current += ch;
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }

    const next = command[i + 1] ?? "";
    const isBreak = ch === ";" || ch === "|" || ch === "&";
    if (isBreak) {
      const trimmed = current.trim();
      if (trimmed) {
        out.push(trimmed);
      }
      current = "";
      if ((ch === "|" || ch === "&") && next === ch) {
        i += 1;
      }
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) {
    out.push(tail);
  }
  return out;
}

function tokenizeShell(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flush = () => {
    if (!current) {
      return;
    }
    tokens.push(current);
    current = "";
  };

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      flush();
      continue;
    }

    current += ch;
  }

  flush();
  return tokens;
}

function isEnvAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function findCommandTokenIndex(tokens: string[]): number {
  let idx = 0;
  while (idx < tokens.length && isEnvAssignmentToken(tokens[idx])) {
    idx += 1;
  }
  if (idx >= tokens.length) {
    return -1;
  }

  if (tokens[idx] === "env") {
    idx += 1;
    while (idx < tokens.length && (tokens[idx].startsWith("-") || isEnvAssignmentToken(tokens[idx]))) {
      idx += 1;
    }
  }
  if (idx >= tokens.length) {
    return -1;
  }

  if (tokens[idx] === "sudo") {
    idx += 1;
    while (idx < tokens.length && tokens[idx].startsWith("-")) {
      idx += 1;
    }
    while (idx < tokens.length && isEnvAssignmentToken(tokens[idx])) {
      idx += 1;
    }
  }

  return idx < tokens.length ? idx : -1;
}

function resolveTokenPath(raw: string, cwd: string): TokenPath | null {
  const token = raw.trim();
  if (!token || token.startsWith("-")) {
    return null;
  }
  if (token.includes("$(") || token.includes("${") || token.includes("`")) {
    return null;
  }

  return {
    raw: token,
    absolute: resolvePathFromBase(token, cwd),
    wildcard: containsWildcard(token)
  };
}

function formatProtectedPath(entry: ProtectedPathEntry, installRoot: string): string {
  const relative = path.relative(installRoot, entry.absolute);
  if (!relative || relative === ".") {
    return entry.absolute;
  }
  return `${entry.absolute} (${relative})`;
}

function throwBlockedDelete(params: {
  command: string;
  target: TokenPath;
  protectedEntry: ProtectedPathEntry;
  installRoot: string;
}): never {
  throw new Error(
    [
      "Blocked destructive command by self-protection policy.",
      `Command: ${params.command}`,
      `Target: ${params.target.raw}`,
      `Protected path: ${formatProtectedPath(params.protectedEntry, params.installRoot)}`
    ].join(" ")
  );
}

function blockIfTargetCoversProtected(params: {
  command: string;
  targets: TokenPath[];
  protectedPaths: ProtectedPathEntry[];
  installRoot: string;
}): void {
  for (const target of params.targets) {
    for (const protectedEntry of params.protectedPaths) {
      if (isPathInside(target.absolute, protectedEntry.absolute)) {
        throwBlockedDelete({
          command: params.command,
          target,
          protectedEntry,
          installRoot: params.installRoot
        });
      }
      if (target.wildcard && (isPathInside(target.absolute, protectedEntry.absolute) || isPathInside(protectedEntry.absolute, target.absolute))) {
        throwBlockedDelete({
          command: params.command,
          target,
          protectedEntry,
          installRoot: params.installRoot
        });
      }
    }
  }
}

function parseDeleteTargets(tokens: string[], commandIndex: number, cwd: string): TokenPath[] {
  const out: TokenPath[] = [];
  let explicitPaths = false;
  let passthrough = false;

  for (let i = commandIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!passthrough && token === "--") {
      passthrough = true;
      continue;
    }
    if (!passthrough && token.startsWith("-")) {
      continue;
    }
    const resolved = resolveTokenPath(token, cwd);
    if (!resolved) {
      continue;
    }
    explicitPaths = true;
    out.push(resolved);
  }

  if (!explicitPaths) {
    out.push({
      raw: ".",
      absolute: path.resolve(cwd),
      wildcard: false
    });
  }
  return out;
}

function parseMoveSources(tokens: string[], commandIndex: number, cwd: string): TokenPath[] {
  const positional: string[] = [];
  let passthrough = false;

  for (let i = commandIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!passthrough && token === "--") {
      passthrough = true;
      continue;
    }
    if (!passthrough && token.startsWith("-")) {
      continue;
    }
    positional.push(token);
  }

  if (positional.length <= 1) {
    return [];
  }

  return positional
    .slice(0, -1)
    .map((raw) => resolveTokenPath(raw, cwd))
    .filter((entry): entry is TokenPath => Boolean(entry));
}

function hasFlag(tokens: string[], longFlag: string, shortFlag?: string): boolean {
  return tokens.some((token) => {
    if (token === longFlag || (shortFlag && token === shortFlag)) {
      return true;
    }
    if (!shortFlag || !shortFlag.startsWith("-") || shortFlag.length !== 2) {
      return false;
    }
    if (!token.startsWith("-") || token.startsWith("--")) {
      return false;
    }
    return token.includes(shortFlag.slice(1));
  });
}

function assertGitCommandAllowed(params: {
  tokens: string[];
  commandIndex: number;
  cwd: string;
  policy: SelfProtectionPolicy;
}): void {
  const sub = params.tokens[params.commandIndex + 1]?.toLowerCase() ?? "";
  if (!sub) {
    return;
  }

  if (sub === "reset" && hasFlag(params.tokens, "--hard")) {
    for (const protectedEntry of params.policy.protectedPaths) {
      if (isPathInside(path.resolve(params.cwd), protectedEntry.absolute)) {
        throw new Error(
          `Blocked destructive git reset in protected directory: ${formatProtectedPath(protectedEntry, params.policy.installRoot)}`
        );
      }
    }
  }

  if (sub === "clean" && hasFlag(params.tokens, "--force", "-f")) {
    for (const protectedEntry of params.policy.protectedPaths) {
      if (isPathInside(path.resolve(params.cwd), protectedEntry.absolute)) {
        throw new Error(
          `Blocked destructive git clean in protected directory: ${formatProtectedPath(protectedEntry, params.policy.installRoot)}`
        );
      }
    }
  }
}

function assertSegmentAllowed(segment: string, cwd: string, policy: SelfProtectionPolicy): void {
  const tokens = tokenizeShell(segment);
  if (tokens.length === 0) {
    return;
  }
  const commandIndex = findCommandTokenIndex(tokens);
  if (commandIndex < 0) {
    return;
  }

  const commandName = path.basename(tokens[commandIndex]).toLowerCase();
  if (commandName === "bash" || commandName === "sh" || commandName === "zsh") {
    for (let i = commandIndex + 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === "-c" || token === "-lc") {
        const inlineScript = tokens[i + 1];
        if (inlineScript?.trim()) {
          assertExecCommandAllowed({
            command: inlineScript,
            cwd,
            policy
          });
        }
      }
    }
  }

  if (commandName === "git") {
    assertGitCommandAllowed({
      tokens,
      commandIndex,
      cwd,
      policy
    });
    return;
  }

  if (commandName === "find" && tokens.some((token) => token.toLowerCase() === "-delete")) {
    const rootToken = tokens[commandIndex + 1] && !tokens[commandIndex + 1].startsWith("-")
      ? tokens[commandIndex + 1]
      : ".";
    const resolvedRoot = resolveTokenPath(rootToken, cwd);
    if (resolvedRoot) {
      blockIfTargetCoversProtected({
        command: segment,
        targets: [resolvedRoot],
        protectedPaths: policy.protectedPaths,
        installRoot: policy.installRoot
      });
    }
    return;
  }

  if (commandName === "mv") {
    const sources = parseMoveSources(tokens, commandIndex, cwd);
    if (sources.length > 0) {
      blockIfTargetCoversProtected({
        command: segment,
        targets: sources,
        protectedPaths: policy.protectedPaths,
        installRoot: policy.installRoot
      });
    }
    return;
  }

  const deleteCommands = new Set(["rm", "rmdir", "unlink", "shred", "wipefs", "mkfs"]);
  if (!deleteCommands.has(commandName)) {
    return;
  }

  const targets = parseDeleteTargets(tokens, commandIndex, cwd);
  if (targets.length === 0) {
    return;
  }

  blockIfTargetCoversProtected({
    command: segment,
    targets,
    protectedPaths: policy.protectedPaths,
    installRoot: policy.installRoot
  });
}

export function resolveSelfProtectionPolicy(params: {
  config?: T560Config;
  workspaceDir?: string;
}): SelfProtectionPolicy {
  const workspaceDir = path.resolve(params.workspaceDir ?? process.cwd());
  const configPolicy = params.config?.tools?.selfProtection;
  const enabled = configPolicy?.enabled !== false;
  const detectedInstallRoot =
    resolveOpenClawPackageRootSync({
      cwd: workspaceDir,
      argv1: process.argv[1],
      moduleUrl: import.meta.url
    }) ?? workspaceDir;

  const installRoot = resolvePathFromBase(
    configPolicy?.installRoot?.trim() || detectedInstallRoot,
    workspaceDir
  );

  const configuredProtected = (configPolicy?.protectedPaths ?? []).map((value) => value.trim()).filter(Boolean);
  const protectedRaw =
    configuredProtected.length > 0 ? configuredProtected : DEFAULT_SELF_PROTECTED_PATHS;
  const protectedEntries = dedupeProtectedPaths([
    { raw: ".", absolute: installRoot },
    ...protectedRaw.map((raw) => ({
      raw,
      absolute: resolvePathFromBase(raw, installRoot)
    }))
  ]);

  return {
    enabled,
    installRoot,
    protectedPaths: protectedEntries
  };
}

export function assertExecCommandAllowed(params: {
  command: string;
  cwd: string;
  policy: SelfProtectionPolicy;
}): void {
  if (!params.policy.enabled) {
    return;
  }

  const segments = splitShellSegments(params.command);
  for (const segment of segments) {
    assertSegmentAllowed(segment, params.cwd, params.policy);
  }
}
