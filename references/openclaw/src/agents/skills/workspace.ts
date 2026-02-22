import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type Skill,
} from "@mariozechner/pi-coding-agent";
import type { T560Config } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import { resolveSandboxPath } from "../sandbox-paths.js";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { shouldIncludeSkill } from "./config.js";
import { normalizeSkillFilter } from "./filter.js";
import {
  parseFrontmatter,
  resolveT560Metadata,
  resolveSkillInvocationPolicy,
} from "./frontmatter.js";
import { resolvePluginSkillDirs } from "./plugin-skills.js";
import { serializeByKey } from "./serialize.js";
import type {
  ParsedSkillFrontmatter,
  SkillEligibilityContext,
  SkillCommandSpec,
  SkillEntry,
  SkillSnapshot,
} from "./types.js";

const fsp = fs.promises;
const skillsLogger = createSubsystemLogger("skills");
const skillCommandDebugOnce = new Set<string>();

/**
 * Replace the user's home directory prefix with `~` in skill file paths
 * to reduce system prompt token usage. Models understand `~` expansion,
 * and the read tool resolves `~` to the home directory.
 *
 * Example: `/Users/alice/.bun/.../skills/github/SKILL.md`
 *       → `~/.bun/.../skills/github/SKILL.md`
 *
 * Saves ~5–6 tokens per skill path × N skills ≈ 400–600 tokens total.
 */
function compactSkillPaths(skills: Skill[]): Skill[] {
  const home = os.homedir();
  if (!home) return skills;
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  return skills.map((s) => ({
    ...s,
    filePath: s.filePath.startsWith(prefix) ? "~/" + s.filePath.slice(prefix.length) : s.filePath,
  }));
}

function debugSkillCommandOnce(
  messageKey: string,
  message: string,
  meta?: Record<string, unknown>,
) {
  if (skillCommandDebugOnce.has(messageKey)) {
    return;
  }
  skillCommandDebugOnce.add(messageKey);
  skillsLogger.debug(message, meta);
}

function filterSkillEntries(
  entries: SkillEntry[],
  config?: T560Config,
  skillFilter?: string[],
  eligibility?: SkillEligibilityContext,
): SkillEntry[] {
  let filtered = entries.filter((entry) => shouldIncludeSkill({ entry, config, eligibility }));
  // If skillFilter is provided, only include skills in the filter list.
  if (skillFilter !== undefined) {
    const normalized = normalizeSkillFilter(skillFilter) ?? [];
    const label = normalized.length > 0 ? normalized.join(", ") : "(none)";
    skillsLogger.debug(`Applying skill filter: ${label}`);
    filtered =
      normalized.length > 0
        ? filtered.filter((entry) => normalized.includes(entry.skill.name))
        : [];
    skillsLogger.debug(
      `After skill filter: ${filtered.map((entry) => entry.skill.name).join(", ") || "(none)"}`,
    );
  }
  return filtered;
}

const SKILL_COMMAND_MAX_LENGTH = 32;
const SKILL_COMMAND_FALLBACK = "skill";
// Discord command descriptions must be ≤100 characters
const SKILL_COMMAND_DESCRIPTION_MAX_LENGTH = 100;

const DEFAULT_MAX_CANDIDATES_PER_ROOT = 300;
const DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE = 200;
const DEFAULT_MAX_SKILLS_IN_PROMPT = 150;
const DEFAULT_MAX_SKILLS_PROMPT_CHARS = 30_000;
const DEFAULT_MAX_SKILL_FILE_BYTES = 256_000;

function sanitizeSkillCommandName(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const trimmed = normalized.slice(0, SKILL_COMMAND_MAX_LENGTH);
  return trimmed || SKILL_COMMAND_FALLBACK;
}

function resolveUniqueSkillCommandName(base: string, used: Set<string>): string {
  const normalizedBase = base.toLowerCase();
  if (!used.has(normalizedBase)) {
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `_${index}`;
    const maxBaseLength = Math.max(1, SKILL_COMMAND_MAX_LENGTH - suffix.length);
    const trimmedBase = base.slice(0, maxBaseLength);
    const candidate = `${trimmedBase}${suffix}`;
    const candidateKey = candidate.toLowerCase();
    if (!used.has(candidateKey)) {
      return candidate;
    }
  }
  const fallback = `${base.slice(0, Math.max(1, SKILL_COMMAND_MAX_LENGTH - 2))}_x`;
  return fallback;
}

type ResolvedSkillsLimits = {
  maxCandidatesPerRoot: number;
  maxSkillsLoadedPerSource: number;
  maxSkillsInPrompt: number;
  maxSkillsPromptChars: number;
  maxSkillFileBytes: number;
};

function resolveSkillsLimits(config?: T560Config): ResolvedSkillsLimits {
  const limits = config?.skills?.limits;
  return {
    maxCandidatesPerRoot: limits?.maxCandidatesPerRoot ?? DEFAULT_MAX_CANDIDATES_PER_ROOT,
    maxSkillsLoadedPerSource:
      limits?.maxSkillsLoadedPerSource ?? DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE,
    maxSkillsInPrompt: limits?.maxSkillsInPrompt ?? DEFAULT_MAX_SKILLS_IN_PROMPT,
    maxSkillsPromptChars: limits?.maxSkillsPromptChars ?? DEFAULT_MAX_SKILLS_PROMPT_CHARS,
    maxSkillFileBytes: limits?.maxSkillFileBytes ?? DEFAULT_MAX_SKILL_FILE_BYTES,
  };
}

function listChildDirectories(dir: string): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push(entry.name);
        continue;
      }
      if (entry.isSymbolicLink()) {
        try {
          if (fs.statSync(fullPath).isDirectory()) {
            dirs.push(entry.name);
          }
        } catch {
          // ignore broken symlinks
        }
      }
    }
    return dirs;
  } catch {
    return [];
  }
}

function resolveNestedSkillsRoot(
  dir: string,
  opts?: {
    maxEntriesToScan?: number;
  },
): { baseDir: string; note?: string } {
  const nested = path.join(dir, "skills");
  try {
    if (!fs.existsSync(nested) || !fs.statSync(nested).isDirectory()) {
      return { baseDir: dir };
    }
  } catch {
    return { baseDir: dir };
  }

  // Heuristic: if `dir/skills/*/SKILL.md` exists for any entry, treat `dir/skills` as the real root.
  // Note: don't stop at 25, but keep a cap to avoid pathological scans.
  const nestedDirs = listChildDirectories(nested);
  const scanLimit = Math.max(0, opts?.maxEntriesToScan ?? 100);
  const toScan = scanLimit === 0 ? [] : nestedDirs.slice(0, Math.min(nestedDirs.length, scanLimit));

  for (const name of toScan) {
    const skillMd = path.join(nested, name, "SKILL.md");
    if (fs.existsSync(skillMd)) {
      return { baseDir: nested, note: `Detected nested skills root at ${nested}` };
    }
  }
  return { baseDir: dir };
}

function unwrapLoadedSkills(loaded: unknown): Skill[] {
  if (Array.isArray(loaded)) {
    return loaded as Skill[];
  }
  if (loaded && typeof loaded === "object" && "skills" in loaded) {
    const skills = (loaded as { skills?: unknown }).skills;
    if (Array.isArray(skills)) {
      return skills as Skill[];
    }
  }
  return [];
}

function loadSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: T560Config;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
  },
): SkillEntry[] {
  const limits = resolveSkillsLimits(opts?.config);

  const loadSkills = (params: { dir: string; source: string }): Skill[] => {
    const resolved = resolveNestedSkillsRoot(params.dir, {
      maxEntriesToScan: limits.maxCandidatesPerRoot,
    });
    const baseDir = resolved.baseDir;

    // If the root itself is a skill directory, just load it directly (but enforce size cap).
    const rootSkillMd = path.join(baseDir, "SKILL.md");
    if (fs.existsSync(rootSkillMd)) {
      try {
        const size = fs.statSync(rootSkillMd).size;
        if (size > limits.maxSkillFileBytes) {
          skillsLogger.warn("Skipping skills root due to oversized SKILL.md.", {
            dir: baseDir,
            filePath: rootSkillMd,
            size,
            maxSkillFileBytes: limits.maxSkillFileBytes,
          });
          return [];
        }
      } catch {
        return [];
      }

      const loaded = loadSkillsFromDir({ dir: baseDir, source: params.source });
      return unwrapLoadedSkills(loaded);
    }

    const childDirs = listChildDirectories(baseDir);
    const suspicious = childDirs.length > limits.maxCandidatesPerRoot;

    const maxCandidates = Math.max(0, limits.maxSkillsLoadedPerSource);
    const limitedChildren = childDirs.slice().sort().slice(0, maxCandidates);

    if (suspicious) {
      skillsLogger.warn("Skills root looks suspiciously large, truncating discovery.", {
        dir: params.dir,
        baseDir,
        childDirCount: childDirs.length,
        maxCandidatesPerRoot: limits.maxCandidatesPerRoot,
        maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource,
      });
    } else if (childDirs.length > maxCandidates) {
      skillsLogger.warn("Skills root has many entries, truncating discovery.", {
        dir: params.dir,
        baseDir,
        childDirCount: childDirs.length,
        maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource,
      });
    }

    const loadedSkills: Skill[] = [];

    // Only consider immediate subfolders that look like skills (have SKILL.md) and are under size cap.
    for (const name of limitedChildren) {
      const skillDir = path.join(baseDir, name);
      const skillMd = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillMd)) {
        continue;
      }
      try {
        const size = fs.statSync(skillMd).size;
        if (size > limits.maxSkillFileBytes) {
          skillsLogger.warn("Skipping skill due to oversized SKILL.md.", {
            skill: name,
            filePath: skillMd,
            size,
            maxSkillFileBytes: limits.maxSkillFileBytes,
          });
          continue;
        }
      } catch {
        continue;
      }

      const loaded = loadSkillsFromDir({ dir: skillDir, source: params.source });
      loadedSkills.push(...unwrapLoadedSkills(loaded));

      if (loadedSkills.length >= limits.maxSkillsLoadedPerSource) {
        break;
      }
    }

    if (loadedSkills.length > limits.maxSkillsLoadedPerSource) {
      return loadedSkills
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, limits.maxSkillsLoadedPerSource);
    }

