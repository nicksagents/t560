import type { InjectedContextFile } from "./bootstrap-context.js";

export function buildAgentSystemPrompt(params: {
  workspaceDir: string;
  skillsPrompt?: string;
  injectedContextFiles?: InjectedContextFile[];
  toolNames?: string[];
  recentArtifacts?: string | null;
  toolHint?: string;
}): string {
  const lines: string[] = [];
  const toolNames = (params.toolNames ?? []).map((tool) => tool.trim()).filter(Boolean);
  const normalizedTools = toolNames.map((tool) => tool.toLowerCase());
  const availableTools = new Set(normalizedTools);
  const readToolName = availableTools.has("read") ? "read" : "exec";

  lines.push("You are a personal assistant running inside T560.", "");
  lines.push("Treat injected project files as authoritative context when present.", "");

  const injectedFiles = params.injectedContextFiles ?? [];
  if (injectedFiles.length > 0) {
    lines.push("## Workspace Files (injected)", "Bootstrap files are included below.", "");
    lines.push("## Project Context");
    for (const file of injectedFiles) {
      lines.push(`<file name="${file.name}" path="${file.path}">`);
      lines.push(file.content || (file.missing ? "(missing file)" : ""));
      lines.push("</file>", "");
    }
  }

  if (toolNames.length > 0) {
    const coreToolSummaries: Record<string, string> = {
      exec: "Run shell commands (supports background via yieldMs/background).",
      process: "Manage background exec sessions.",
      read: "Read full file content from disk.",
      write: "Write file content (files with editable markers allow changes only inside those regions).",
      edit: "Find/replace text in files (respects editable markers).",
      ls: "List directory contents.",
      find: "Search for files by path substring.",
      exists: "Check whether a file or directory exists.",
      browser:
        "Stateful browser navigation with tabs/history/snapshot/search/click/forms/fill/submit/hover/press/select/drag/evaluate/upload/dialog/console/pdf/scroll/resize/back/forward; use engine=live for SPA/reactive sites.",
      web_search: "Search DuckDuckGo and optionally fetch top results for grounded excerpts.",
      web_fetch: "Fetch a URL and return a readable text snapshot.",
    };
    const toolOrder = [
      "read",
      "write",
      "edit",
      "ls",
      "find",
      "exists",
      "browser",
      "web_search",
      "web_fetch",
      "exec",
      "process",
    ];
    const canonicalByNormalized = new Map<string, string>();
    for (const name of toolNames) {
      const normalized = name.toLowerCase();
      if (!canonicalByNormalized.has(normalized)) {
        canonicalByNormalized.set(normalized, name);
      }
    }
    const resolveToolName = (normalized: string) =>
      canonicalByNormalized.get(normalized) ?? normalized;
    const enabledTools = toolOrder.filter((tool) => availableTools.has(tool));
    const extraTools = normalizedTools.filter((tool) => !toolOrder.includes(tool));
    const toolLines = enabledTools.map((tool) => {
      const summary = coreToolSummaries[tool];
      const name = resolveToolName(tool);
      return summary ? `- ${name}: ${summary}` : `- ${name}`;
    });
    for (const tool of extraTools.sort()) {
      const name = resolveToolName(tool);
      toolLines.push(`- ${name}`);
    }

    lines.push(
      "## Tooling",
      "Tool availability (filtered by policy):",
      "Tool names are case-sensitive. Call tools exactly as listed.",
      toolLines.length > 0 ? toolLines.join("\n") : "- (no tools enabled)",
      "",
      "## Tool Call Style",
      "For simple greetings/acknowledgements (for example: hi, hello, thanks), do not call tools; reply directly.",
      `When a file contains ${"T560_EDITABLE_START"} / ${"T560_EDITABLE_END"} markers, only modify text between those markers.`,
      "Default: do not narrate routine, low-risk tool calls (just call the tool).",
      "Narrate only when it helps: multi-step work, complex problems, or destructive actions.",
      "Never claim completion unless tool results confirm success.",
      ""
    );

    if (availableTools.has("web_search") || availableTools.has("web_fetch")) {
      lines.push(
        "## Web Grounding",
        "For time-sensitive facts or external references, use web tools first, then cite results from tool output.",
        'For multi-step website navigation, prefer `browser` (search/open/snapshot/click/forms/fill/submit/back/forward) over ad-hoc URL guessing.',
        "When a site is JS-heavy (React/Vue/SPA), use `browser` with `engine=live`.",
        "For complex pages, call `browser` snapshot first and use returned element refs (`e1`, `e2`, ...) with `click`/`fill`/`submit`/`hover`/`press`/`select`/`drag`/`act`.",
        "Use `console` to inspect browser logs, `dialog` to arm confirm/prompt handling, `upload` for file inputs, `scroll`/`resize` for viewport control, and `pdf` to export current page.",
        ""
      );
    }
  }

  if (params.skillsPrompt?.trim()) {
    lines.push(
      "## Skills (mandatory)",
      "Before replying: scan <available_skills> <description> entries.",
      `- If exactly one skill clearly applies: read its SKILL.md at <location> with \`${readToolName}\`, then follow it.`,
      "- If multiple could apply: choose the most specific one, then read/follow it.",
      "- If none clearly apply: do not read any SKILL.md.",
      "Constraints: never read more than one skill up front; only read after selecting.",
      params.skillsPrompt.trim(),
      ""
    );
  }

  if (params.recentArtifacts?.trim()) {
    lines.push("## Recent Artifacts", params.recentArtifacts.trim(), "");
  }

  if (params.toolHint?.trim()) {
    lines.push("## Task Hint", params.toolHint.trim(), "");
  }

  lines.push(
    "## Workspace",
    `Your working directory is: ${params.workspaceDir}`,
    "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.",
    ""
  );

  return lines.join("\n");
}
