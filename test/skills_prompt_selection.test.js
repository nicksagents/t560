import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { createT560CodingTools } from "../src/agents/pi-tools.ts";
import { resolveSkillsPromptForRun, resolveToolSkillRemindersForRun } from "../src/agents/skills.ts";

test("skills resolver injects only matching tool skills when tool names are provided", async () => {
  const prompt = await resolveSkillsPromptForRun({
    workspaceDir: process.cwd(),
    toolNames: ["browser"],
  });
  assert.ok(prompt);
  assert.match(String(prompt), /<tool_skills>/);
  assert.match(String(prompt), /name="web-human-browser"/);
  assert.match(String(prompt), /name="web-login-vault"/);
  assert.match(String(prompt), /skills\/web-human-browser\/SKILL\.md/);
  assert.doesNotMatch(String(prompt), /name="terminal-exec"/);
  assert.match(String(prompt), /# Web Human Browser/);
});

test("skills resolver falls back to available summaries when no tool skill matches", async () => {
  const prompt = await resolveSkillsPromptForRun({
    workspaceDir: process.cwd(),
    toolNames: ["totally_unknown_tool"],
  });
  assert.ok(prompt);
  assert.match(String(prompt), /<available_skills>/);
  assert.match(String(prompt), /terminal-exec:/);
});

function parseToolsFromFrontmatter(raw) {
  const match = String(raw).match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return [];
  }
  const frontmatter = match[1];
  const line = frontmatter
    .split(/\r?\n/)
    .find((entry) => /^tools\s*:/i.test(entry.trim()));
  if (!line) {
    return [];
  }
  const tail = line.replace(/^tools\s*:/i, "").trim();
  if (!tail.startsWith("[") || !tail.endsWith("]")) {
    return [];
  }
  return tail
    .slice(1, -1)
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, "").toLowerCase())
    .filter(Boolean);
}

test("every runtime tool is covered by at least one skill tools metadata entry", async () => {
  const skillsRoot = path.join(process.cwd(), "skills");
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const mappedTools = new Set();

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillPath = path.join(skillsRoot, entry.name, "SKILL.md");
    try {
      const raw = await readFile(skillPath, "utf-8");
      for (const toolName of parseToolsFromFrontmatter(raw)) {
        mappedTools.add(toolName);
      }
    } catch {
      // Ignore unreadable skill files.
    }
  }

  const runtimeTools = createT560CodingTools({
    workspaceDir: process.cwd(),
    senderIsOwner: true,
  }).map((tool) => String(tool.name ?? "").trim().toLowerCase()).filter(Boolean);

  const uncovered = Array.from(new Set(runtimeTools)).filter((toolName) => !mappedTools.has(toolName)).sort();
  assert.deepEqual(uncovered, []);
});

test("tool reminder map includes guidance for every enabled runtime tool", async () => {
  const runtimeTools = createT560CodingTools({
    workspaceDir: process.cwd(),
    senderIsOwner: true,
  }).map((tool) => String(tool.name ?? "").trim().toLowerCase()).filter(Boolean);
  const reminders = await resolveToolSkillRemindersForRun({
    workspaceDir: process.cwd(),
    toolNames: runtimeTools,
  });
  const uncovered = Array.from(new Set(runtimeTools)).filter((toolName) => !reminders[toolName]).sort();
  assert.deepEqual(uncovered, []);
  assert.match(String(reminders.browser), /<tool_brief tool="browser">/);
});
