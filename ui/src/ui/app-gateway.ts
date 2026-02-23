import { GatewayBrowserClient } from "./gateway.js";
import type { T560App } from "./app.js";
import { uuid } from "./uuid.js";

type LiveProgressState = {
  messageId: string | null;
  lines: string[];
  lastLine: string;
  lastAt: number;
};

const progressByHost = new WeakMap<T560App, LiveProgressState>();

function getLiveProgressState(host: T560App): LiveProgressState {
  const existing = progressByHost.get(host);
  if (existing) {
    return existing;
  }
  const created: LiveProgressState = {
    messageId: null,
    lines: [],
    lastLine: "",
    lastAt: 0,
  };
  progressByHost.set(host, created);
  return created;
}

function resetLiveProgressState(host: T560App): void {
  progressByHost.set(host, {
    messageId: null,
    lines: [],
    lastLine: "",
    lastAt: 0,
  });
}

function summarizeAgentEvent(event: any): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  if (event.stream === "assistant") {
    const text = typeof event.data?.text === "string" ? event.data.text.trim() : "";
    return text || null;
  }
  return null;
}

function pushLiveProgress(host: T560App, line: string): void {
  const text = line.trim();
  if (!text) {
    return;
  }

  const now = Date.now();
  const state = getLiveProgressState(host);
  if (text === state.lastLine && now - state.lastAt < 5000) {
    return;
  }
  if (now - state.lastAt < 450) {
    return;
  }

  state.lastLine = text;
  state.lastAt = now;
  state.lines = [...state.lines, text].slice(-8);
  const content = `**Working update**\n${state.lines.map((entry) => `- ${entry}`).join("\n")}`;

  if (!state.messageId) {
    state.messageId = uuid();
    host.chatMessages = [
      ...host.chatMessages,
      {
        id: state.messageId,
        role: "assistant",
        content,
        thinking: null,
        toolCalls: [],
        timestamp: now,
        provider: null,
        model: null,
      },
    ];
    progressByHost.set(host, state);
    return;
  }

  const idx = host.chatMessages.findIndex((msg) => msg.id === state.messageId);
  if (idx < 0) {
    state.messageId = uuid();
    host.chatMessages = [
      ...host.chatMessages,
      {
        id: state.messageId,
        role: "assistant",
        content,
        thinking: null,
        toolCalls: [],
        timestamp: now,
        provider: null,
        model: null,
      },
    ];
    progressByHost.set(host, state);
    return;
  }

  const updated = [...host.chatMessages];
  updated[idx] = {
    ...updated[idx],
    content,
    timestamp: now,
  };
  host.chatMessages = updated;
  progressByHost.set(host, state);
}

/** Connect the gateway WebSocket and wire events to the app */
export function connectGateway(host: T560App): void {
  // Determine WebSocket URL from current location
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = host.settings.gatewayUrl || `${proto}//${location.host}/ws`;
  console.log(`[gateway] Connecting to: ${wsUrl}`);

  if (host.gateway) {
    host.gateway.close();
  }

  const gateway = new GatewayBrowserClient({
    url: wsUrl,

    onHello(payload: any) {
      host.connected = true;
      host.lastError = "";

      // Apply snapshot if provided
      if (payload?.snapshot) {
        const snap = payload.snapshot;
        if (snap.status) host.serverStatus = snap.status;
        if (!host.sessionKey && snap.sessionKey) host.sessionKey = snap.sessionKey;
      }

      gateway.request("chat.history", {
        sessionKey: host.sessionKey || undefined,
        limit: 120,
      }).then((historyPayload: any) => {
        if (historyPayload?.sessionKey) {
          host.sessionKey = String(historyPayload.sessionKey);
        }
        const messages = Array.isArray(historyPayload?.messages) ? historyPayload.messages : [];
        const mapped = messages.map((item: any) => ({
          id: String(item?.id ?? uuid()),
          role: item?.role === "user" ? "user" : "assistant",
          content: String(item?.message ?? ""),
          thinking: null,
          toolCalls: [],
          timestamp: typeof item?.timestamp === "number" ? item.timestamp : Date.now(),
          provider: null,
          model: null,
        }));
        // Keep locally restored messages if the server has no history for this session.
        if (mapped.length > 0 || host.chatMessages.length === 0) {
          host.chatMessages = mapped;
        }
      }).catch(() => {
        // Older gateways may not implement chat.history yet.
      });
    },

    onEvent(event: string, payload: any) {
      handleGatewayEvent(host, event, payload);
    },

    onClose(_code: number, _reason: string) {
      host.connected = false;
    },

    onError(error: string) {
      host.lastError = error;
    },
  });

  host.gateway = gateway;
  gateway.connect();
}

function handleGatewayEvent(host: T560App, event: string, payload: any): void {
  switch (event) {
    case "chat": {
      handleChatEvent(host, payload);
      break;
    }
    case "chat.sending": {
      host.chatSending = true;
      resetLiveProgressState(host);
      break;
    }
    case "chat.done": {
      host.chatSending = false;
      host.chatLoading = false;
      resetLiveProgressState(host);
      // Flush queue
      if (host.chatQueue.length > 0) {
        const next = host.chatQueue[0];
        host.chatQueue = host.chatQueue.slice(1);
        host.sendMessage(next);
      }
      break;
    }
    case "agent.event": {
      const line = summarizeAgentEvent(payload);
      if (line) {
        pushLiveProgress(host, line);
      }
      break;
    }
    case "chat.error": {
      host.chatSending = false;
      host.chatLoading = false;
      resetLiveProgressState(host);
      const errMsg = payload?.message ?? "An error occurred";
      host.chatMessages = [
        ...host.chatMessages,
        {
          id: uuid(),
          role: "assistant",
          content: `**Error:** ${errMsg}`,
          thinking: null,
          toolCalls: [],
          timestamp: Date.now(),
        },
      ];
      break;
    }
    case "status": {
      if (payload) host.serverStatus = payload;
      break;
    }
    default:
      break;
  }
}

function handleChatEvent(host: T560App, payload: any): void {
  if (!payload) return;

  const msg = {
    id: payload.id ?? uuid(),
    role: payload.role as "user" | "assistant",
    content: payload.message ?? "",
    thinking: payload.thinking ?? null,
    toolCalls: payload.toolCalls ?? [],
    timestamp: payload.timestamp ?? Date.now(),
    provider: payload.provider ?? null,
    model: payload.model ?? null,
  };

  // Check if this is an update to an existing message (streaming)
  const existing = host.chatMessages.findIndex((m) => m.id === msg.id);
  if (existing >= 0) {
    const updated = [...host.chatMessages];
    updated[existing] = msg;
    host.chatMessages = updated;
  } else {
    host.chatMessages = [...host.chatMessages, msg];
  }
}
