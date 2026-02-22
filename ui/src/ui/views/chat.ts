import type { T560App } from "../app.js";
import { icons } from "../icons.js";
import { groupMessages, renderMessageGroup, renderReadingIndicator } from "../chat/grouped-render.js";

/** Render the full chat view */
export function renderChatView(host: T560App): string {
  const groups = groupMessages(host.chatMessages);
  const messagesHtml = groups.map((g) => renderMessageGroup(g, host.showThinking)).join("");

  const emptyState = host.chatMessages.length === 0
    ? `<div style="flex:1;display:flex;align-items:center;justify-content:center;text-align:center;color:var(--muted);padding:40px">
        <div>
          <div style="font-size:32px;margin-bottom:12px;opacity:0.4">💬</div>
          <div style="font-size:15px;font-weight:500">Start a conversation</div>
          <div style="font-size:13px;margin-top:6px;opacity:0.7">Type a message below to chat with t560</div>
        </div>
      </div>`
    : "";

  const readingIndicator = host.chatLoading ? renderReadingIndicator() : "";

  const newMessagesBadge = host.hasNewMessages
    ? `<button class="chat-new-messages" data-action="scroll-bottom">
        ${icons.arrowDown} New messages
      </button>`
    : "";

  // Compose area
  const placeholder = host.connected
    ? "Message (↩ to send, Shift+↩ for line breaks)"
    : "Connect to the gateway to start chatting…";

  const sendOrStop = host.chatSending
    ? `<button class="btn danger" data-action="abort">${icons.square} Stop</button>`
    : `<button class="btn primary" data-action="send">${icons.send} Send<span class="btn-kbd">↩</span></button>`;

  // Attachments preview
  const attachmentsHtml = host.chatAttachments.length > 0
    ? `<div class="chat-attachments">
        ${host.chatAttachments.map((a, i) => `
          <div class="chat-attachment">
            <img class="chat-attachment__img" src="${a.dataUrl}" alt="attachment" />
            <button class="chat-attachment__remove" data-action="remove-attachment" data-index="${i}" title="Remove">
              ${icons.x}
            </button>
          </div>
        `).join("")}
      </div>`
    : "";

  // Chat header controls
  const thinkingToggle = `<div class="chat-controls__thinking">
    <button class="btn--icon" data-action="toggle-thinking" title="${host.showThinking ? "Hide" : "Show"} thinking" aria-label="Toggle thinking visibility">
      ${host.showThinking ? icons.eye : icons.eyeOff}
    </button>
    <span class="muted" style="font-size:11px">${host.showThinking ? "Thinking" : "Hidden"}</span>
  </div>`;

  // Queue display
  const queueHtml = host.chatQueue.length > 0
    ? `<div class="chat-queue">
        <div class="chat-queue__title">Queued messages (${host.chatQueue.length})</div>
        <div class="chat-queue__list">
          ${host.chatQueue.map((q, i) => `
            <div class="chat-queue__item">
              <div class="chat-queue__text">${q}</div>
              <button class="btn btn--sm chat-queue__remove" data-action="remove-queue" data-index="${i}">✕</button>
            </div>
          `).join("")}
        </div>
      </div>`
    : "";

  return `<div class="content content--chat">
    <div class="content-header">
      <div>
        <div class="page-title">Chat</div>
        <div class="page-sub">Session: <span class="mono">${host.sessionKey || "default"}</span></div>
      </div>
      <div class="chat-controls">
        ${thinkingToggle}
      </div>
    </div>
    <div class="chat">
      <div class="chat-thread" role="log" aria-live="polite" aria-label="Chat messages">
        ${emptyState}
        ${messagesHtml}
        ${readingIndicator}
      </div>
      ${newMessagesBadge}
      ${queueHtml}
      <div class="chat-compose">
        ${attachmentsHtml}
        <div class="chat-compose__row">
          <div class="chat-compose__field field">
            <textarea
              placeholder="${placeholder}"
              ${!host.connected ? "disabled" : ""}
              data-input="chat"
              aria-label="Chat message input"
            ></textarea>
          </div>
          <div class="chat-compose__actions">
            ${sendOrStop}
          </div>
        </div>
      </div>
    </div>
  </div>`;
}
