import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command, Option } from "commander";
import { resolveStateDir } from "../config/paths.js";
import { routeLogsToStderr } from "../logging/console.js";
import { pathExists } from "../utils.js";
import { getCoreCliCommandNames, registerCoreCliByName } from "./program/command-registry.js";
import { getProgramContext } from "./program/program-context.js";
import { getSubCliEntries, registerSubCliByName } from "./program/register.subclis.js";

const COMPLETION_SHELLS = ["zsh", "bash", "powershell", "fish"] as const;
type CompletionShell = (typeof COMPLETION_SHELLS)[number];

function isCompletionShell(value: string): value is CompletionShell {
  return COMPLETION_SHELLS.includes(value as CompletionShell);
}

export function resolveShellFromEnv(env: NodeJS.ProcessEnv = process.env): CompletionShell {
  const shellPath = env.SHELL?.trim() ?? "";
  const shellName = shellPath ? path.basename(shellPath).toLowerCase() : "";
  if (shellName === "zsh") {
    return "zsh";
  }
  if (shellName === "bash") {
    return "bash";
  }
  if (shellName === "fish") {
    return "fish";
  }
  if (shellName === "pwsh" || shellName === "powershell") {
    return "powershell";
  }
  return "zsh";
}

function sanitizeCompletionBasename(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "t560";
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function resolveCompletionCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, os.homedir);
  return path.join(stateDir, "completions");
}

export function resolveCompletionCachePath(shell: CompletionShell, binName: string): string {
  const basename = sanitizeCompletionBasename(binName);
  const extension =
    shell === "powershell" ? "ps1" : shell === "fish" ? "fish" : shell === "bash" ? "bash" : "zsh";
  return path.join(resolveCompletionCacheDir(), `${basename}.${extension}`);
}

/** Check if the completion cache file exists for the given shell. */
export async function completionCacheExists(
  shell: CompletionShell,
  binName = "t560",
): Promise<boolean> {
  const cachePath = resolveCompletionCachePath(shell, binName);
  return pathExists(cachePath);
}

function getCompletionScript(shell: CompletionShell, program: Command): string {
  if (shell === "zsh") {
    return generateZshCompletion(program);
  }
  if (shell === "bash") {
    return generateBashCompletion(program);
  }
  if (shell === "powershell") {
    return generatePowerShellCompletion(program);
  }
  return generateFishCompletion(program);
}

async function writeCompletionCache(params: {
  program: Command;
  shells: CompletionShell[];
  binName: string;
}): Promise<void> {
  const cacheDir = resolveCompletionCacheDir();
  await fs.mkdir(cacheDir, { recursive: true });
  for (const shell of params.shells) {
    const script = getCompletionScript(shell, params.program);
    const targetPath = resolveCompletionCachePath(shell, params.binName);
    await fs.writeFile(targetPath, script, "utf-8");
  }
}

function formatCompletionSourceLine(
  shell: CompletionShell,
  binName: string,
  cachePath: string,
): string {
  if (shell === "fish") {
    return `source "${cachePath}"`;
  }
  return `source "${cachePath}"`;
}

function isCompletionProfileHeader(line: string): boolean {
  return line.trim() === "# T560 Completion";
}

function isCompletionProfileLine(line: string, binName: string, cachePath: string | null): boolean {
  if (line.includes(`${binName} completion`)) {
    return true;
  }
  if (cachePath && line.includes(cachePath)) {
    return true;
  }
  return false;
}

/** Check if a line uses the slow dynamic completion pattern (source <(...)) */
function isSlowDynamicCompletionLine(line: string, binName: string): boolean {
  // Matches patterns like: source <(t560 completion --shell zsh)
  return (
    line.includes(`<(${binName} completion`) ||
    (line.includes(`${binName} completion`) && line.includes("| source"))
  );
}

function updateCompletionProfile(
  content: string,
  binName: string,
  cachePath: string | null,
  sourceLine: string,
): { next: string; changed: boolean; hadExisting: boolean } {
  const lines = content.split("\n");
  const filtered: string[] = [];
  let hadExisting = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (isCompletionProfileHeader(line)) {
      hadExisting = true;
      i += 1;
      continue;
    }
    if (isCompletionProfileLine(line, binName, cachePath)) {
      hadExisting = true;
      continue;
    }
    filtered.push(line);
  }

  const trimmed = filtered.join("\n").trimEnd();
  const block = `# T560 Completion\n${sourceLine}`;
  const next = trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  return { next, changed: next !== content, hadExisting };
}

function getShellProfilePath(shell: CompletionShell): string {
  const home = process.env.HOME || os.homedir();
  if (shell === "zsh") {
    return path.join(home, ".zshrc");
  }
  if (shell === "bash") {
    return path.join(home, ".bashrc");
  }
  if (shell === "fish") {
    return path.join(home, ".config", "fish", "config.fish");
  }
  // PowerShell
  if (process.platform === "win32") {
    return path.join(
      process.env.USERPROFILE || home,
      "Documents",
      "PowerShell",
      "Microsoft.PowerShell_profile.ps1",
    );
  }
  return path.join(home, ".config", "powershell", "Microsoft.PowerShell_profile.ps1");
}

export async function isCompletionInstalled(
  shell: CompletionShell,
  binName = "t560",
): Promise<boolean> {
  const profilePath = getShellProfilePath(shell);

  if (!(await pathExists(profilePath))) {
    return false;
  }
  const cachePathCandidate = resolveCompletionCachePath(shell, binName);
  const cachedPath = (await pathExists(cachePathCandidate)) ? cachePathCandidate : null;
  const content = await fs.readFile(profilePath, "utf-8");
  const lines = content.split("\n");
  return lines.some(
    (line) => isCompletionProfileHeader(line) || isCompletionProfileLine(line, binName, cachedPath),
  );
}

/**
 * Check if the profile uses the slow dynamic completion pattern.
 * Returns true if profile has `source <(t560 completion ...)` instead of cached file.
 */
export async function usesSlowDynamicCompletion(
  shell: CompletionShell,
  binName = "t560",
): Promise<boolean> {
  const profilePath = getShellProfilePath(shell);

  if (!(await pathExists(profilePath))) {
    return false;
  }

  const cachePath = resolveCompletionCachePath(shell, binName);
  const content = await fs.readFile(profilePath, "utf-8");
  const lines = content.split("\n");

  // Check if any line has dynamic completion but NOT the cached path
  for (const line of lines) {
    if (isSlowDynamicCompletionLine(line, binName) && !line.includes(cachePath)) {
      return true;
    }
