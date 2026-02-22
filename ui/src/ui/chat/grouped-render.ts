import type { ChatMessage } from "../app.js";
import { renderMarkdown, detectDirection } from "../markdown.js";
import { renderToolCards } from "./tool-cards.js";
import { renderCopyButton } from "./copy-as-markdown.js";

export interface MessageGroup {
  role: "user" | "assistant";
  messages: ChatMessage[];
}

/** Group consecutive messages from the same role */
export function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (const msg of messages) {
    const last = groups[groups.length - 1];
    if (last && last.role === msg.role) {
      last.messages.push(msg);
    } else {
      groups.push({ role: msg.role, messages: [msg] });
    }
  }
  return groups;
}

/** Render a single message group as HTML */
export function renderMessageGroup(group: MessageGroup, showThinking: boolean): string {
  const isUser = group.role === "user";
  const avatarClass = isUser ? "user" : "assistant";
  const avatarLabel = isUser ? "You" : "t5";

  const bubblesHtml = group.messages.map((msg) => {
    let html = "";

    // Thinking block
    if (showThinking && msg.thinking) {
      html += `<div class="chat-thinking">${renderMarkdown(msg.thinking)}</div>`;
    }

    // Tool cards
    if (msg.toolCalls.length > 0) {
      html += renderToolCards(msg.toolCalls);
    }

    // Message content
    if (msg.content) {
      const dir = detectDirection(msg.content);
      const hasContent = !isUser;
      const copyBtn = hasContent ? renderCopyButton(msg.content) : "";
      const copyClass = hasContent ? " has-copy" : "";

      html += `<div class="chat-bubble fade-in${copyClass}">
        ${copyBtn}
        <div class="chat-text" dir="${dir}">${renderMarkdown(msg.content)}</div>
      </div>`;
    }

    return html;
  }).join("");

  // Footer with sender name and timestamp
  const firstMsg = group.messages[0];
  const time = new Date(firstMsg.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const senderName = isUser ? "You" : "t560";

  return `<div class="chat-group ${group.role}">
    <div class="chat-avatar ${avatarClass}">${avatarLabel}</div>
    <div class="chat-group-messages">
      ${bubblesHtml}
      <div class="chat-group-footer">
        <span class="chat-sender-name">${senderName}</span>
        <span class="chat-group-timestamp">${time}</span>
      </div>
    </div>
  </div>`;
}

/** Render the reading indicator (animated dots) */
export function renderReadingIndicator(): string {
  return `<div class="chat-group assistant">
    <div class="chat-avatar assistant">t5</div>
    <div class="chat-group-messages">
      <div class="chat-bubble chat-reading-indicator">
        <div class="chat-reading-indicator__dots">
          <span></span><span></span><span></span>
        </div>
      </div>
    </div>
  </div>`;
}
