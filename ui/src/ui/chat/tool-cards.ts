import { escapeHtml } from "../markdown.js";
import { icons } from "../icons.js";

/** Render tool call cards */
export function renderToolCards(toolCalls: string[]): string {
  if (toolCalls.length === 0) return "";

  const cards = toolCalls.map((tc) => {
    const escaped = escapeHtml(tc);
    // Try to parse as "tool_name: description" or just show the raw string
    const colonIdx = tc.indexOf(":");
    const title = colonIdx > 0 ? tc.slice(0, colonIdx).trim() : tc;
    const detail = colonIdx > 0 ? tc.slice(colonIdx + 1).trim() : "";

    return `<div class="chat-tool-card">
      <div class="chat-tool-card__header">
        <span class="chat-tool-card__title">
          <span class="chat-tool-card__icon">${icons.tool}</span>
          <span class="mono">${escapeHtml(title)}</span>
        </span>
        <span class="chat-tool-card__status">${icons.checkCircle}</span>
      </div>
      ${detail ? `<div class="chat-tool-card__detail">${escapeHtml(detail)}</div>` : ""}
    </div>`;
  }).join("");

  return `<div class="chat-tool-cards">${cards}</div>`;
}
