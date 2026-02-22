import type { T560App } from "./app.js";
import { uuid, shortId } from "./uuid.js";

/** Send a chat message through the gateway */
export function sendMessage(host: T560App, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  // Handle chat commands
  if (trimmed.startsWith("/")) {
    const cmd = trimmed.toLowerCase();
    if (cmd === "/new") {
      host.sessionKey = shortId();
      host.chatMessages = [];
      host.chatQueue = [];
      return;
    }
    if (cmd === "/stop") {
      abortChat(host);
      return;
    }
  }

  // Queue if already sending
  if (host.chatSending) {
    host.chatQueue = [...host.chatQueue, trimmed];
    return;
  }

  if (!host.gateway?.connected) {
    host.lastError = "Not connected to gateway";
    return;
  }

  // Add user message to UI immediately
  host.chatMessages = [
    ...host.chatMessages,
    {
      id: uuid(),
      role: "user",
      content: trimmed,
      thinking: null,
      toolCalls: [],
      timestamp: Date.now(),
    },
  ];

  host.chatSending = true;
  host.chatLoading = true;

  // Collect attachment data URLs
  const attachments = host.chatAttachments.map((a) => a.dataUrl);

  host.gateway.request("chat.send", {
    message: trimmed,
    sessionKey: host.sessionKey || undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
  }).catch((err: Error) => {
    host.chatSending = false;
    host.chatLoading = false;
    host.lastError = err.message;
  });

  // Clear attachments after sending
  host.chatAttachments = [];
}

/** Abort the current chat request */
export function abortChat(host: T560App): void {
  if (!host.gateway?.connected) return;

  host.gateway.send("chat.abort", {
    sessionKey: host.sessionKey || undefined,
  });
  host.chatSending = false;
  host.chatLoading = false;
}
