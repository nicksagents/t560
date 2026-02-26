import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { T560Config } from "../config/state.js";

type ResolveSkillsPromptOptions = {
  workspaceDir?: string;
  config?: T560Config;
  compactMode?: boolean;
  toolNames?: string[];
};

type ParsedSkillSummary = {
  name: string;
  description: string;
  toolNames: string[];
};

type SkillEntry = ParsedSkillSummary & {
  location: string;
  content: string;
};

const DEFAULT_MAX_INJECTED_SKILLS = 10;
const DEFAULT_COMPACT_MAX_INJECTED_SKILLS = 6;
const DEFAULT_SKILL_CONTENT_MAX_CHARS = 2_400;
const DEFAULT_COMPACT_SKILL_CONTENT_MAX_CHARS = 900;
const DEFAULT_TOOL_REMINDER_MAX_SKILLS = 3;
const DEFAULT_COMPACT_TOOL_REMINDER_MAX_SKILLS = 2;
const DEFAULT_TOOL_REMINDER_SNIPPET_CHARS = 420;
const DEFAULT_COMPACT_TOOL_REMINDER_SNIPPET_CHARS = 220;

async function canAccess(dirPath: string): Promise<boolean> {
  try {
    await access(dirPath);
    return true;
  } catch {
    return false;
  }
}

function firstNonEmptyLine(value: string): string {
  const line = value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line ?? "";
}

function extractFrontmatter(raw: string): string | undefined {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  return match?.[1];
}

function parseInlineList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return [];
  }
  const inside = trimmed.slice(1, -1).trim();
  if (!inside) {
    return [];
  }
  return inside
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, "").toLowerCase())
    .filter(Boolean);
}

function parseToolNamesFromFrontmatter(frontmatter: string | undefined): string[] {
  if (!frontmatter) {
    return [];
  }
  const lines = frontmatter.split(/\r?\n/);
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (value: string) => {
    const normalized = value.trim().replace(/^["']|["']$/g, "").toLowerCase();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    out.push(normalized);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^tools\s*:\s*(.*)$/i.exec(line);
    if (!match) {
      continue;
    }
    const tail = match[1].trim();
    if (tail.length > 0) {
      const inline = parseInlineList(tail);
      if (inline.length > 0) {
        inline.forEach(add);
      } else {
        add(tail);
      }
      continue;
    }
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor];
      const listMatch = /^\s*-\s*(.+?)\s*$/.exec(candidate);
      if (!listMatch) {
        break;
      }
      add(listMatch[1]);
      index = cursor;
    }
  }

  return out;
}

function clampSkillContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  const bodyMax = Math.max(300, maxChars - 80);
  return `${content.slice(0, bodyMax).trimEnd()}\n\n[TRUNCATED: SKILL.md exceeds ${maxChars} characters]`;
}

function parseSkillSummary(raw: string, fallbackName: string): ParsedSkillSummary {
  const frontmatter = extractFrontmatter(raw);
  const source = frontmatter ?? raw;
  const frontmatterLines = source.split(/\r?\n/);
  const nameLine = frontmatterLines.find((line) => /^name\s*:/i.test(line));
  const descLine = frontmatterLines.find((line) => /^description\s*:/i.test(line));

  const name = nameLine
    ? nameLine.replace(/^name\s*:/i, "").trim() || fallbackName
    : fallbackName;

  const description = descLine
    ? descLine.replace(/^description\s*:/i, "").trim()
    : firstNonEmptyLine(raw.replace(/---[\s\S]*?---/g, "")).slice(0, 160);

  return {
    name,
    description: description || "No description provided.",
    toolNames: parseToolNamesFromFrontmatter(frontmatter),
  };
}

function normalizeToolNames(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    const normalized = String(entry ?? "").trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function buildAvailableSkillsPrompt(summaries: SkillEntry[], compactMode: boolean): string | undefined {
  if (summaries.length === 0) {
    return undefined;
  }
  const lines = ["<available_skills>"];
  for (const summary of summaries.slice(0, compactMode ? 10 : 20)) {
    if (compactMode) {
      lines.push(`- ${summary.name} (file: ${summary.location})`);
      continue;
    }
    lines.push(`- ${summary.name}: ${summary.description} (file: ${summary.location})`);
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function buildInjectedToolSkillsPrompt(
  skills: SkillEntry[],
  compactMode: boolean,
): string | undefined {
  if (skills.length === 0) {
    return undefined;
  }
  const lines = ["<tool_skills>"];
  const maxSkills = compactMode ? DEFAULT_COMPACT_MAX_INJECTED_SKILLS : DEFAULT_MAX_INJECTED_SKILLS;
  const maxChars = compactMode ? DEFAULT_COMPACT_SKILL_CONTENT_MAX_CHARS : DEFAULT_SKILL_CONTENT_MAX_CHARS;
  for (const skill of skills.slice(0, maxSkills)) {
    const tools = skill.toolNames.length > 0 ? skill.toolNames.join(",") : "";
    lines.push(`<skill name="${skill.name}" tools="${tools}" file="${skill.location}">`);
    lines.push(clampSkillContent(skill.content, maxChars));
    lines.push("</skill>", "");
  }
  lines.push("</tool_skills>");
  return lines.join("\n");
}

function stripFrontmatter(content: string): string {
  return String(content ?? "").replace(/^---[\s\S]*?---\s*/m, "").trim();
}

function compactWhitespace(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function clampChars(value: string, maxChars: number): string {
  const normalized = compactWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function buildToolReminderForSkill(skill: SkillEntry, maxChars: number): string {
  const body = stripFrontmatter(skill.content);
  if (!body) {
    return "";
  }
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^#{1,6}\s/.test(line));
  if (lines.length === 0) {
    return "";
  }
  return clampChars(lines.slice(0, 6).join(" "), maxChars);
}

async function loadSkillEntries(workspaceDir: string): Promise<SkillEntry[]> {
  const skillsRoot = path.join(workspaceDir, "skills");
  if (!(await canAccess(skillsRoot))) {
    return [];
  }

  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const summaries: SkillEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillPath = path.join(skillsRoot, entry.name, "SKILL.md");
    try {
      const raw = await readFile(skillPath, "utf-8");
      const parsed = parseSkillSummary(raw, entry.name);
      summaries.push({
        ...parsed,
        location: skillPath,
        content: raw.trim(),
      });
    } catch {
      // Skip unreadable skills.
    }
  }

  return summaries;
}

export async function resolveToolSkillRemindersForRun(options: {
  workspaceDir?: string;
  compactMode?: boolean;
  toolNames?: string[];
}): Promise<Record<string, string>> {
  const workspaceDir = path.resolve(options.workspaceDir ?? process.cwd());
  const compactMode = options.compactMode === true;
  const normalizedToolNames = normalizeToolNames(options.toolNames);
  if (normalizedToolNames.length === 0) {
    return {};
  }
  const summaries = await loadSkillEntries(workspaceDir);
  if (summaries.length === 0) {
    return {};
  }

  const out: Record<string, string> = {};
  const maxSkills = compactMode ? DEFAULT_COMPACT_TOOL_REMINDER_MAX_SKILLS : DEFAULT_TOOL_REMINDER_MAX_SKILLS;
  const maxSnippetChars = compactMode
    ? DEFAULT_COMPACT_TOOL_REMINDER_SNIPPET_CHARS
    : DEFAULT_TOOL_REMINDER_SNIPPET_CHARS;
  for (const toolName of normalizedToolNames) {
    const matches = summaries
      .filter((skill) => skill.toolNames.includes(toolName))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (matches.length === 0) {
      continue;
    }
    const lines = [`<tool_brief tool="${toolName}">`];
    for (const skill of matches.slice(0, maxSkills)) {
      lines.push(`- ${skill.name}: ${skill.description}`);
      const reminder = buildToolReminderForSkill(skill, maxSnippetChars);
      if (reminder) {
        lines.push(`  ${reminder}`);
      }
    }
    lines.push("</tool_brief>");
    out[toolName] = lines.join("\n");
  }

  return out;
}

export async function resolveSkillsPromptForRun(
  options: ResolveSkillsPromptOptions = {},
): Promise<string | undefined> {
  const workspaceDir = path.resolve(options.workspaceDir ?? process.cwd());
  const summaries = await loadSkillEntries(workspaceDir);
  if (summaries.length === 0) {
    return undefined;
  }

  const compactMode = options.compactMode === true;
  const normalizedToolNames = normalizeToolNames(options.toolNames);
  if (normalizedToolNames.length > 0 && summaries.length > 0) {
    const requestedTools = new Set(normalizedToolNames);
    const matchedSkills = summaries
      .map((skill) => ({
        skill,
        score: skill.toolNames.reduce((acc, toolName) => acc + (requestedTools.has(toolName) ? 1 : 0), 0),
      }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .map((row) => row.skill);

    const toolSkillsPrompt = buildInjectedToolSkillsPrompt(matchedSkills, compactMode);
    if (toolSkillsPrompt) {
      return toolSkillsPrompt;
    }
  }

  return buildAvailableSkillsPrompt(summaries, compactMode);
}
