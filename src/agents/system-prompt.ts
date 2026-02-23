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
  const now = new Date();
  const currentDateIso = now.toISOString().slice(0, 10);
  const toolNames = (params.toolNames ?? []).map((tool) => tool.trim()).filter(Boolean);
  const normalizedTools = toolNames.map((tool) => tool.toLowerCase());
  const availableTools = new Set(normalizedTools);
  const readToolName = availableTools.has("read") ? "read" : "exec";

  lines.push("You are a personal assistant running inside T560.", "");
  lines.push(`Current date (UTC): ${currentDateIso}.`, "");
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
        "Stateful browser navigation with tabs/history/snapshot/search/click/forms/fill/submit/login/mfa/hover/press/select/drag/evaluate/upload/dialog/console/pdf/scroll/resize/back/forward; use engine=live for SPA/reactive sites.",
      web_search:
        "Search the web for up-to-date info (Brave when configured, DuckDuckGo fallback) and optionally fetch top results for grounded excerpts.",
      web_fetch: "Fetch a URL and return a readable text snapshot.",
      memory_search:
        "Search saved memory entries and workspace memory docs (MEMORY.md/memory/*.md) for prior decisions, preferences, and context.",
      memory_get: "Fetch exact memory content by ref/id/path for precise recall.",
      memory_save: "Persist durable non-secret memory (preferences, recurring workflows, decisions).",
      memory_delete: "Delete outdated or incorrect durable memory entries by id/ref/title.",
      memory_list: "List durable memory entries with filters for audit/debug visibility.",
      memory_prune: "Apply retention cleanup to stale memory entries (supports dry-run).",
      memory_feedback: "Reinforce or down-rank memory entries based on usefulness feedback.",
      memory_stats: "Report memory quality analytics (namespace distribution, trust mix, stale candidates).",
      memory_compact: "Compact durable memory storage after heavy updates/deletes.",
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
      "memory_search",
      "memory_get",
      "memory_save",
      "memory_delete",
      "memory_list",
      "memory_prune",
      "memory_feedback",
      "memory_stats",
      "memory_compact",
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
      "Communication style: sound like a pragmatic teammate, not a template generator.",
      "During multi-step tasks, include natural-language progress updates while you work, not just at the end.",
      "Each progress update should be 1-2 full sentences and include concrete details: what you checked, what you observed, and what you plan to do next.",
      "When relevant, mention the specific site/page/file you just checked and a concrete observation (for example URL, page title, file path, value, or count).",
      "Avoid generic filler such as 'I am using the latest findings to choose the next step.'",
      "In user-facing updates and final responses, avoid naming internal tools; describe actions in plain language.",
      "Avoid rigid labels such as 'Finding:' or 'Next step:' unless the user explicitly asks for that format.",
      "For non-trivial tasks, structure the final response with short sections: what you did, what you found, and what happens next.",
      "If you are blocked on user input (for example MFA), say exactly what is needed in one short sentence.",
      "Never invent observations; only report what is directly supported by current tool outputs.",
      "Never claim completion unless tool results confirm success.",
      ""
    );

    const hasWebSearch = availableTools.has("web_search");
    const hasWebFetch = availableTools.has("web_fetch");
    const hasBrowser = availableTools.has("browser");
    if (hasWebSearch || hasWebFetch || hasBrowser) {
      lines.push(
        "## Web Grounding",
        "For time-sensitive facts or external references, use available web tools first, then cite results from tool output.",
        "For requests containing words like current/latest/today/right now/live, verify source dates and do not rely on stale-year pages when newer year pages are available.",
      );
      if (hasWebSearch && hasWebFetch) {
        lines.push(
          "For single-step factual lookups (news/checks/quick verification), prefer `web_search` then `web_fetch` for the most relevant URLs."
        );
      } else if (hasWebSearch) {
        lines.push(
          "For single-step factual lookups (news/checks/quick verification), use `web_search` first; use `browser` only when interaction is required."
        );
      } else if (hasWebFetch && hasBrowser) {
        lines.push(
          "If `web_search` is unavailable, use `browser` action=`search`/`open` to find URLs, then use `web_fetch` for clean text grounding."
        );
      } else if (hasWebFetch) {
        lines.push("Use `web_fetch` for user-provided URLs and ground answers from fetched text.");
      }
      if (hasBrowser) {
        lines.push(
          'For multi-step website navigation, prefer `browser` (search/open/snapshot/click/forms/fill/submit/back/forward) over ad-hoc URL guessing.',
          "Important: `browser` action=`open` uses an internal tool tab and may not open a visible desktop browser window.",
          "If the user asks to open a browser/window for them on their machine, use `browser` action=`launch` with the target URL.",
          "When a site is JS-heavy (React/Vue/SPA), use `browser` with `engine=live`.",
          "For complex pages, call `browser` snapshot first and use returned element refs (`e1`, `e2`, ...) with `click`/`fill`/`submit`/`hover`/`press`/`select`/`drag`/`act`.",
          "For login pages with stored credentials, use `browser` action=`login` with `service=<site>` (examples: email, x.com, havenvaults2-0) to avoid requesting or exposing secrets.",
          "If `browser` login returns `requiresMfa: true`, ask the user for the one-time code in one short line, then immediately call `browser` action=`mfa` with `code` once they provide it.",
          "When the user sends a likely one-time code (4-10 digits), do not ask them to repeat it; use it directly via `browser` action=`mfa`.",
          "If credentials are missing, tell the user to run `/setup <service-or-site>` in chat rather than asking them to paste passwords directly.",
          "Use `console` to inspect browser logs, `dialog` to arm confirm/prompt handling, `upload` for file inputs, `scroll`/`resize` for viewport control, and `pdf` to export current page.",
          'Before purchase/checkout actions (for example "buy now", "place order", payment submit), ask for explicit user confirmation phrase: "confirm purchase".',
        );
      }
      lines.push("");
    }

    const hasMemorySearch = availableTools.has("memory_search");
    const hasMemoryGet = availableTools.has("memory_get");
    const hasMemorySave = availableTools.has("memory_save");
    const hasMemoryDelete = availableTools.has("memory_delete");
    const hasMemoryList = availableTools.has("memory_list");
    const hasMemoryPrune = availableTools.has("memory_prune");
    const hasMemoryFeedback = availableTools.has("memory_feedback");
    const hasMemoryStats = availableTools.has("memory_stats");
    const hasMemoryCompact = availableTools.has("memory_compact");
    if (hasMemorySearch || hasMemoryGet || hasMemorySave || hasMemoryDelete || hasMemoryList || hasMemoryPrune || hasMemoryFeedback || hasMemoryStats || hasMemoryCompact) {
      lines.push("## Memory Recall");
      if (hasMemorySearch && hasMemoryGet) {
        lines.push(
          "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search first, then use memory_get for exact snippets you need to cite.",
          "Use namespace and minTrustTier parameters to avoid cross-user leakage and low-confidence memory.",
        );
      } else if (hasMemorySearch) {
        lines.push(
          "Before answering about prior work, preferences, or decisions, run memory_search and ground your response in returned memory snippets.",
        );
      }
      if (hasMemorySave) {
        lines.push(
          "When the user shares durable preferences, recurring workflows, or stable account context, save concise notes with memory_save.",
          "If new facts contradict an existing memory, use memory_save with onConflict='replace' to supersede stale entries.",
          "Use namespace/trustTier on save to keep memory scoped and trustworthy; namespace quotas may evict low-signal entries automatically.",
          "Never store secrets (passwords, one-time codes, private keys, tokens, recovery phrases).",
        );
      }
      if (hasMemoryDelete) {
        lines.push(
          "If the user corrects prior facts or asks to forget stale context, delete the outdated entry with memory_delete.",
        );
      }
      if (hasMemoryList) {
        lines.push("Use memory_list when auditing what durable memory is currently stored.");
      }
      if (hasMemoryPrune) {
        lines.push("Use memory_prune (dry-run first) for retention cleanup when memory becomes stale or oversized.");
      }
      if (hasMemoryFeedback) {
        lines.push("Use memory_feedback to reinforce memories that proved useful and down-rank ones that were noisy or wrong.");
      }
      if (hasMemoryStats) {
        lines.push("Use memory_stats to audit memory quality and detect stale/noisy namespaces before pruning.");
      }
      if (hasMemoryCompact) {
        lines.push("Use memory_compact (dry-run first) after many updates/deletes to keep memory storage fast and clean.");
      }
      lines.push("If memory search is low confidence, say you checked memory and what remained uncertain.", "");
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
