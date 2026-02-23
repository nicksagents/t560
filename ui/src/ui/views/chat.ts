import type { T560App } from "../app.js";
import { icons } from "../icons.js";
import { groupMessages, renderMessageGroup, renderReadingIndicator } from "../chat/grouped-render.js";

/** Render the full chat view */
export function renderChatView(host: T560App): string {
  const groups = groupMessages(host.chatMessages);
  const messagesHtml = groups.map((g) => renderMessageGroup(g, host.showThinking)).join("");

  const emptyState = host.chatMessages.length === 0
    ? `<div class="chat-empty-state chat-empty-state--plain">
        <div class="chat-empty-state__sub">Start chatting below.</div>
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
    ? "enter your query here"
    : "Connect to the gateway to start chatting…";

  const sendOrStop = host.chatSending
    ? `<button class="btn danger" data-action="abort">${icons.square} Stop</button>`
    : `<button class="btn primary" data-action="send">${icons.send} Submit</button>`;

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

  return `<div class="content content--chat content--chat-plain">
    <div class="chat">
      <button class="chat-corner-new" data-action="new-chat-session" title="Start new chat" aria-label="Start new chat">
        ${icons.messageCircle}
      </button>
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
