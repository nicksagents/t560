import type { ChatResponse } from "../agent/chat-service.js";
import { isRich, theme } from "../cli/theme.js";
import type { AgentEvent } from "../agents/agent-events.js";

// ── Terminal formatting (OpenClaw-style TUI) ───────────────────────────
//
// Matches OpenClaw's visual hierarchy:
//   • User messages:     dark background (#2B2F36) with light text
//   • Assistant messages: terminal default foreground, left-padded
//   • Thinking:          [thinking] header in accent, dimmed body
//   • Tool calls:        colored background box per state
//   • Code blocks:       bordered with codeBorder, code-colored text
//   • Markdown:          headings bold-accent, bullets accentSoft, etc.

const COLUMNS = () => process.stdout.columns || 80;

// ── User message ───────────────────────────────────────────────────────

export function formatTerminalUserMessage(message: string): string {
  const r = isRich();
  if (!r) return `> ${message}`;

  const cols = COLUMNS();
  const lines = message.split("\n");
  const out: string[] = [""];  // spacer like OpenClaw

  for (const line of lines) {
    // Pad line to full width with bg color, like OpenClaw UserMessageComponent
    const padded = ` ${line}`.padEnd(cols);
    out.push(theme.userBg(theme.userText(padded)));
  }

  return out.join("\n");
}

// ── Assistant message ──────────────────────────────────────────────────

export function formatTerminalResponse(reply: ChatResponse): string {
  const r = isRich();
  const parts: string[] = [""];  // spacer like OpenClaw

  // Thinking block
  if (reply.thinking) {
    parts.push(formatThinkingBlock(reply.thinking, r));
    parts.push("");
  }

  // Main response — rendered as markdown, left-padded 1 char
  // OpenClaw uses terminal default foreground for assistant text
  if (reply.message) {
    parts.push(renderTerminalMarkdown(reply.message, r));
  }

  return parts.join("\n");
}

// ── Thinking ───────────────────────────────────────────────────────────

function formatThinkingBlock(thinking: string, rich: boolean): string {
  if (!rich) return `[thinking]\n${thinking}`;

  const lines = thinking.split("\n");
  const out: string[] = [];
  out.push(theme.accent("[thinking]"));
  for (const line of lines) {
    out.push(theme.dim(` ${line}`));
  }
  return out.join("\n");
}

// ── Tool execution box ─────────────────────────────────────────────────
// Mimics OpenClaw ToolExecutionComponent:
//   pending  → bg #1F2A2F, "(running)" suffix
//   success  → bg #1E2D23
//   error    → bg #2F1F1F

function formatToolBox(toolName: string, rich: boolean): string {
  if (!rich) return `[tool] ${toolName}`;

  const cols = COLUMNS();
  const title = theme.bold(theme.toolTitle(`⚡ ${toolName}`));
  const padded = ` ${toolName}`.padEnd(cols);
  return (
    theme.toolSuccessBg(theme.toolTitle(` ⚡ ${toolName}`.padEnd(cols)))
  );
}

type ToolEventFormat = {
  phase: "start" | "update" | "end" | "error";
  toolName: string;
  args?: Record<string, unknown>;
  partialResult?: unknown;
  result?: unknown;
  error?: string;
};

const TOOL_PREVIEW_LINES = 12;
const TOOL_LINE_MAX = 180;

function truncateLine(text: string, max = TOOL_LINE_MAX): string {
  if (text.length <= max) {
    return text;
  }
  const head = Math.max(0, Math.floor(max * 0.6));
  const tail = Math.max(0, max - head - 3);
  return `${text.slice(0, head)}...${text.slice(text.length - tail)}`;
}

function renderToolHeader(params: { toolName: string; state: "running" | "ok" | "error" }) {
  const rich = isRich();
  const cols = COLUMNS();
  const label =
    params.state === "running"
      ? `${params.toolName} (running)`
      : params.state === "error"
        ? `${params.toolName} (error)`
        : `${params.toolName} (done)`;
  if (!rich) {
    return `⚡ ${label}`;
  }
  const padded = ` ⚡ ${label}`.padEnd(cols);
  const bg =
    params.state === "running"
      ? theme.toolPendingBg
      : params.state === "error"
        ? theme.toolErrorBg
        : theme.toolSuccessBg;
  return bg(theme.toolTitle(padded));
}

function formatToolArgs(args?: Record<string, unknown>): string[] {
  if (!args) {
    return [];
  }
  const lines: string[] = [];
  const command = typeof args.command === "string" ? args.command : undefined;
  const workdir =
    typeof args.workdir === "string"
      ? args.workdir
      : typeof args.cwd === "string"
        ? args.cwd
        : undefined;
  if (command) {
    lines.push(`command: ${truncateLine(command)}`);
  }
  if (workdir) {
    lines.push(`cwd: ${truncateLine(workdir, 120)}`);
  }
  const extra = { ...args };
  delete extra.command;
  delete extra.workdir;
  delete extra.cwd;
  if (Object.keys(extra).length > 0 && lines.length === 0) {
    try {
      lines.push(`args: ${truncateLine(JSON.stringify(extra))}`);
    } catch {
      lines.push("args: [unprintable]");
    }
  }
  return lines;
}

function extractToolText(result?: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }
  const record = result as Record<string, unknown>;
  const content = record.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const entry of content) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const rec = entry as Record<string, unknown>;
      if (rec.type === "text" && typeof rec.text === "string") {
        parts.push(rec.text);
      }
    }
    return parts.join("\n").trim();
  }
  if (typeof record.stdout === "string" || typeof record.stderr === "string") {
    const stdout = typeof record.stdout === "string" ? record.stdout : "";
    const stderr = typeof record.stderr === "string" ? record.stderr : "";
    return [stdout, stderr].filter(Boolean).join("\n").trim();
  }
  return "";
}

function formatToolResultSummary(result?: unknown, error?: string): string[] {
  const lines: string[] = [];
  if (!result || typeof result !== "object") {
    if (error) {
      lines.push(`error: ${truncateLine(error, 220)}`);
    }
    return lines;
  }
  const record = result as Record<string, unknown>;
  const details = record.details;
  if (details && typeof details === "object") {
    const d = details as Record<string, unknown>;
    const status = typeof d.status === "string" ? d.status : undefined;
    const exitCode = typeof d.exitCode === "number" ? d.exitCode : undefined;
    const cwd = typeof d.cwd === "string" ? d.cwd : undefined;
    const command = typeof d.command === "string" ? d.command : undefined;
    if (status) {
      lines.push(`status: ${status}`);
    }
    if (exitCode !== undefined) {
      lines.push(`exit: ${exitCode}`);
    }
    if (cwd) {
      lines.push(`cwd: ${truncateLine(cwd, 120)}`);
    }
    if (command) {
      lines.push(`command: ${truncateLine(command)}`);
    }
    if (typeof d.stdout === "string" && d.stdout.trim()) {
      lines.push("stdout:");
      lines.push(...d.stdout.trim().split("\n").slice(0, TOOL_PREVIEW_LINES));
      if (d.stdout.trim().split("\n").length > TOOL_PREVIEW_LINES) {
        lines.push("…");
      }
    }
    if (typeof d.stderr === "string" && d.stderr.trim()) {
      lines.push("stderr:");
      lines.push(...d.stderr.trim().split("\n").slice(0, TOOL_PREVIEW_LINES));
      if (d.stderr.trim().split("\n").length > TOOL_PREVIEW_LINES) {
        lines.push("…");
      }
    }
  }
  const text = extractToolText(result);
  if (text && lines.length === 0) {
    lines.push(...text.split("\n").slice(0, TOOL_PREVIEW_LINES));
    if (text.split("\n").length > TOOL_PREVIEW_LINES) {
      lines.push("…");
    }
  }
  if (error) {
    lines.push(`error: ${truncateLine(error, 220)}`);
  }
  return lines;
}

export function formatTerminalToolEvent(event: AgentEvent): string | null {
  if (event.stream !== "tool") {
    return null;
  }

  const phase = event.data.phase;
  const toolName = event.data.name || "tool";
  const args = event.data.args;
  const partialResult = event.data.partialResult;
  const result = event.data.result;
  const error = event.data.error;

  if (phase === "update" && partialResult && typeof partialResult === "object") {
    const rec = partialResult as Record<string, unknown>;
    const stream = typeof rec.stream === "string" ? rec.stream : "";
    const chunk = typeof rec.chunk === "string" ? rec.chunk : "";
    if (chunk) {
      const prefix = stream ? `${stream}: ` : "";
      return `${isRich() ? theme.dim("  ↳ ") : "  ↳ "}${truncateLine(prefix + chunk.trim(), 160)}`;
    }
    return null;
  }

  if (phase === "start") {
    const lines = [renderToolHeader({ toolName, state: "running" })];
    const argLines = formatToolArgs(args);
    for (const line of argLines) {
      lines.push(isRich() ? theme.dim(`  ${line}`) : `  ${line}`);
    }
    return lines.join("\n");
  }

  if (phase === "end" || phase === "error") {
    const state =
      phase === "error" ? "error" : error ? "error" : "ok";
    const lines = [renderToolHeader({ toolName, state })];
    const summaries = formatToolResultSummary(result, error);
    for (const line of summaries) {
      lines.push(isRich() ? theme.dim(`  ${line}`) : `  ${line}`);
    }
    return lines.join("\n");
  }

  return null;
}

// ── Markdown renderer ──────────────────────────────────────────────────
// Matches OpenClaw markdownTheme:
//   heading:         bold + accent (#F6C453)
//   link:            #7DD3A5
//   code:            #F0C987
//   codeBlockBorder: #343A45
//   quote:           #8CC8FF
//   quoteBorder:     #3B4D6B
//   hr:              #3C414B (border)
//   listBullet:      #F2A65A (accentSoft)
//   bold/italic:     standard

function renderTerminalMarkdown(text: string, rich: boolean): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let inCodeBlock = false;
  let codeLang = "";

  for (const line of lines) {
    // Code block fences
    if (line.trimStart().startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = line.trimStart().slice(3).trim();
        const label = codeLang || "";
        const borderLen = Math.max(0, 48 - label.length - 2);
        if (rich) {
          output.push(
            theme.codeBorder(" ┌─") +
            (label ? theme.code(` ${label} `) : theme.codeBorder("─")) +
            theme.codeBorder("─".repeat(borderLen))
          );
        } else {
          output.push(` ┌─${label ? ` ${label} ` : "─"}${"─".repeat(borderLen)}`);
        }
      } else {
        inCodeBlock = false;
        codeLang = "";
        if (rich) {
          output.push(theme.codeBorder(" └" + "─".repeat(50)));
        } else {
          output.push(` └${"─".repeat(50)}`);
        }
      }
      continue;
    }

    if (inCodeBlock) {
      if (rich) {
        output.push(theme.codeBorder(" │") + theme.code(` ${line}`));
      } else {
        output.push(` │ ${line}`);
      }
      continue;
    }

    // Headings → bold accent (OpenClaw: chalk.bold(fg(palette.accent)(text)))
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      if (rich) {
        output.push(` ${theme.heading(headingMatch[2])}`);
      } else {
        output.push(` ${headingMatch[2]}`);
      }
      continue;
    }

    // Horizontal rules → border color
    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      if (rich) {
        output.push(theme.border(` ${"─".repeat(50)}`));
      } else {
        output.push(` ${"─".repeat(50)}`);
      }
      continue;
    }

    // Blockquotes → quote color with quoteBorder left bar
    if (line.trimStart().startsWith("> ")) {
      const quoteText = line.replace(/^>\s?/, "");
      if (rich) {
        output.push(theme.quoteBorder(" ▎ ") + theme.quote(quoteText));
      } else {
        output.push(` ▎ ${quoteText}`);
      }
      continue;
    }

    // List items → accentSoft bullet
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      const indent = listMatch[1];
      const content = renderInlineMarkdown(listMatch[3], rich);
      if (rich) {
        output.push(` ${indent}${theme.accentSoft("•")} ${content}`);
      } else {
        output.push(` ${indent}• ${content}`);
      }
      continue;
    }

    // Empty line
    if (!line.trim()) {
      output.push("");
      continue;
    }

    // Regular text — 1 char left pad, inline markdown
    output.push(` ${renderInlineMarkdown(line, rich)}`);
  }

  return output.join("\n");
}

function renderInlineMarkdown(text: string, rich: boolean): string {
  if (!rich) return text;

  // Bold **text** → chalk.bold
  let result = text.replace(/\*\*(.+?)\*\*/g, (_m, p1) => theme.bold(p1));
  // Italic *text* → chalk.italic
  result = result.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, (_m, p1) => theme.italic(p1));
  // Inline code `text` → code color
  result = result.replace(/`([^`]+)`/g, (_m, p1) => theme.code(p1));
  // Links [text](url) → link color + dim url
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label, url) => theme.link(label) + theme.dim(` (${url})`)
  );
  // Strikethrough ~~text~~
  result = result.replace(/~~(.+?)~~/g, (_m, p1) => theme.strikethrough(p1));

  return result;
}

// ── Waiting / status line ──────────────────────────────────────────────
// Matches OpenClaw's shimmer waiting animation

const WAITING_PHRASES = [
  "flibbertigibbeting",
  "kerfuffling",
  "dillydallying",
  "twiddling thumbs",
  "noodling",
  "bamboozling",
  "moseying",
  "hobnobbing",
  "pondering",
  "conjuring",
];

export function pickWaitingPhrase(tick: number): string {
  const idx = Math.floor(tick / 10) % WAITING_PHRASES.length;
  return WAITING_PHRASES[idx] ?? "waiting";
}

export function shimmerText(text: string, tick: number): string {
  if (!isRich()) return text;

  const width = 6;
  const pos = tick % (text.length + width);
  const start = Math.max(0, pos - width);
  const end = Math.min(text.length - 1, pos);

  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    out += i >= start && i <= end
      ? theme.bold(theme.accentSoft(ch))
      : theme.dim(ch);
  }
  return out;
}

export function formatWaitingStatus(tick: number, elapsed: string): string {
  const phrase = pickWaitingPhrase(tick);
  const shimmer = shimmerText(`${phrase}…`, tick);
  return `${shimmer} ${theme.dim("•")} ${theme.dim(elapsed)}`;
}

export function formatElapsed(startMs: number): string {
  const totalSeconds = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

// ── Footer ─────────────────────────────────────────────────────────────

export function formatFooter(params: {
  mode: string;
  provider?: string | null;
  model?: string | null;
}): string {
  const r = isRich();
  const parts: string[] = ["t560"];
  parts.push(params.mode);
  if (params.provider && params.model) {
    parts.push(`${params.provider}/${params.model}`);
  }
  const joined = parts.join(" | ");
  return r ? theme.dim(joined) : joined;
}

// ── Telegram formatting (HTML parse mode) ──────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatTelegramResponse(reply: ChatResponse): string {
  const parts: string[] = [];

  if (reply.thinking) {
    const escaped = escapeHtml(reply.thinking);
    parts.push(`<blockquote expandable>💭 <b>Thinking</b>\n${escaped}</blockquote>`);
  }

  if (reply.toolCalls.length > 0) {
    const tools = reply.toolCalls
      .map((name) => `⚡ <code>${escapeHtml(name)}</code>`)
      .join("\n");
    parts.push(tools);
  }

  if (reply.message) {
    parts.push(markdownToTelegramHtml(reply.message));
  }

  return parts.join("\n\n");
}

function markdownToTelegramHtml(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let inCodeBlock = false;
  let codeBuffer: string[] = [];
  let codeLang = "";

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = line.trimStart().slice(3).trim();
        codeBuffer = [];
      } else {
        const langAttr = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : "";
        output.push(`<pre><code${langAttr}>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`);
        inCodeBlock = false;
        codeLang = "";
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    output.push(markdownLineToTelegramHtml(line));
  }

  if (inCodeBlock && codeBuffer.length > 0) {
    output.push(`<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`);
  }

  return output.join("\n");
}

function markdownLineToTelegramHtml(line: string): string {
  const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
  if (headingMatch) {
    return `<b>${escapeHtml(headingMatch[1])}</b>`;
  }

  if (line.trimStart().startsWith("> ")) {
    const quoteText = line.replace(/^>\s?/, "");
    return `<blockquote>${telegramInlineFormat(quoteText)}</blockquote>`;
  }

  return telegramInlineFormat(line);
}

function telegramInlineFormat(text: string): string {
  let result = escapeHtml(text);
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, "<i>$1</i>");
  result = result.replace(/`([^`]+)`/g, "<code>$1</code>");
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");
  return result;
}

// ── Webchat formatting (HTML for browser rendering) ────────────────────

export function formatWebchatMessage(reply: ChatResponse): {
  html: string;
  thinkingHtml: string | null;
  toolCallsHtml: string | null;
  providerInfo: string | null;
} {
  const thinkingHtml = reply.thinking
    ? `<details class="thinking-block"><summary>💭 Thinking</summary><pre class="thinking-content">${escapeHtml(reply.thinking)}</pre></details>`
    : null;

  const toolCallsHtml =
    reply.toolCalls.length > 0
      ? reply.toolCalls
          .map(
            (name) =>
              `<div class="tool-call"><span class="tool-icon">⚡</span> <code>${escapeHtml(name)}</code></div>`
          )
          .join("")
      : null;

  const html = markdownToWebHtml(reply.message);
  return { html, thinkingHtml, toolCallsHtml, providerInfo: null };
}

function markdownToWebHtml(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let inCodeBlock = false;
  let codeBuffer: string[] = [];
  let codeLang = "";

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = line.trimStart().slice(3).trim();
        codeBuffer = [];
      } else {
        const langLabel = codeLang
          ? `<span class="code-lang">${escapeHtml(codeLang)}</span>`
          : "";
        output.push(
          `<div class="code-block">${langLabel}<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre></div>`
        );
        inCodeBlock = false;
        codeLang = "";
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      output.push(`<h${level + 1}>${webInlineFormat(headingMatch[2])}</h${level + 1}>`);
      continue;
    }

    if (line.trimStart().startsWith("> ")) {
      const quoteText = line.replace(/^>\s?/, "");
      output.push(`<blockquote>${webInlineFormat(quoteText)}</blockquote>`);
      continue;
    }

    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      output.push("<hr />");
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      output.push(`<div class="list-item">${webInlineFormat(listMatch[3])}</div>`);
      continue;
    }

    if (!line.trim()) {
      output.push("<br />");
      continue;
    }

    output.push(`<p>${webInlineFormat(line)}</p>`);
  }

  if (inCodeBlock && codeBuffer.length > 0) {
    output.push(
      `<div class="code-block"><pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre></div>`
    );
  }

  return output.join("\n");
}

function webInlineFormat(text: string): string {
  let result = escapeHtml(text);
  result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  result = result.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, "<em>$1</em>");
  result = result.replace(/`([^`]+)`/g, "<code>$1</code>");
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");
  return result;
}
