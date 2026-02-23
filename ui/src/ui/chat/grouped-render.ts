import type { ChatMessage } from "../app.js";
import { renderMarkdown, detectDirection } from "../markdown.js";
import { renderCopyButton } from "./copy-as-markdown.js";

export interface MessageGroup {
  role: "user" | "assistant";
  messages: ChatMessage[];
}

/** Group consecutive messages from the same role */
export function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  return messages.map((msg) => ({ role: msg.role, messages: [msg] }));
}

/** Render a single message group as HTML */
export function renderMessageGroup(group: MessageGroup, showThinking: boolean): string {
  const msg = group.messages[0];
  const isUser = msg.role === "user";
  const roleLabel = isUser ? "user" : "assistant";
  const roleClass = isUser ? "role-user" : "role-assistant";

  let bodyHtml = "";
  if (showThinking && msg.thinking) {
    bodyHtml += `<div class="chat-thinking">${renderMarkdown(msg.thinking)}</div>`;
  }
  if (msg.content) {
    const dir = detectDirection(msg.content);
    const hasCopy = !isUser;
    const copyBtn = hasCopy ? renderCopyButton(msg.content) : "";
    const copyClass = hasCopy ? " has-copy" : "";
    bodyHtml += `<div class="chat-bubble fade-in${copyClass}">
      ${copyBtn}
      <div class="chat-text" dir="${dir}">${renderMarkdown(msg.content)}</div>
    </div>`;
  }

  const time = new Date(msg.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return `<div class="chat-group ${group.role}">
    <div class="chat-role ${roleClass}">${roleLabel}</div>
    <div class="chat-group-messages">
      ${bodyHtml}
      <div class="chat-group-footer">
        <span class="chat-group-timestamp">${time}</span>
      </div>
    </div>
  </div>`;
}

/** Render the reading indicator (animated dots) */
export function renderReadingIndicator(): string {
  return `<div class="chat-group assistant">
    <div class="chat-role role-assistant">assistant</div>
    <div class="chat-group-messages">
      <div class="chat-bubble chat-reading-indicator">
        <div class="chat-reading-indicator__dots">
          <span></span><span></span><span></span>
        </div>
      </div>
    </div>
  </div>`;
}
