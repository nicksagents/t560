import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { T560Config } from "../config/state.js";

type ResolveSkillsPromptOptions = {
  workspaceDir?: string;
  config?: T560Config;
};

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

function parseSkillSummary(raw: string, fallbackName: string): { name: string; description: string } {
  const lines = raw.split(/\r?\n/);
  const nameLine = lines.find((line) => /^name\s*:/i.test(line));
  const descLine = lines.find((line) => /^description\s*:/i.test(line));

  const name = nameLine
    ? nameLine.replace(/^name\s*:/i, "").trim() || fallbackName
    : fallbackName;

  const description = descLine
    ? descLine.replace(/^description\s*:/i, "").trim()
    : firstNonEmptyLine(raw.replace(/---[\s\S]*?---/g, "")).slice(0, 160);

  return {
    name,
    description: description || "No description provided.",
  };
}

export async function resolveSkillsPromptForRun(
  options: ResolveSkillsPromptOptions = {},
): Promise<string | undefined> {
  const workspaceDir = path.resolve(options.workspaceDir ?? process.cwd());
  const skillsRoot = path.join(workspaceDir, "skills");
  if (!(await canAccess(skillsRoot))) {
    return undefined;
  }

  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const summaries: Array<{ name: string; description: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillPath = path.join(skillsRoot, entry.name, "SKILL.md");
    try {
      const raw = await readFile(skillPath, "utf-8");
      summaries.push(parseSkillSummary(raw, entry.name));
    } catch {
      // Skip unreadable skills.
    }
  }

  if (summaries.length === 0) {
    return undefined;
  }

  const lines = ["<available_skills>"];
  for (const summary of summaries.slice(0, 20)) {
    lines.push(`- ${summary.name}: ${summary.description}`);
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}
