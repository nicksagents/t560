import type { ChatMessage } from "./app.js";

interface PersistedChatState {
  version: 1;
  sessionKey: string;
  messages: ChatMessage[];
  queue: string[];
}

const CHAT_STATE_KEY = "t560-ui-chat-state-v1";
const CHAT_DRAFT_KEY = "t560-ui-chat-draft-v1";
const MAX_STORED_MESSAGES = 200;
const MAX_STORED_QUEUE = 20;
const MAX_DRAFT_CHARS = 8000;

function sanitizeMessage(input: unknown): ChatMessage | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const role = value.role === "user" ? "user" : value.role === "assistant" ? "assistant" : null;
  if (!role) return null;
  return {
    id: typeof value.id === "string" ? value.id : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    content: typeof value.content === "string" ? value.content : "",
    thinking: typeof value.thinking === "string" ? value.thinking : null,
    toolCalls: Array.isArray(value.toolCalls) ? value.toolCalls.filter((v): v is string => typeof v === "string") : [],
    timestamp: typeof value.timestamp === "number" ? value.timestamp : Date.now(),
    provider: typeof value.provider === "string" ? value.provider : null,
    model: typeof value.model === "string" ? value.model : null,
  };
}

export function loadPersistedChatState(): PersistedChatState {
  try {
    const raw = localStorage.getItem(CHAT_STATE_KEY);
    if (!raw) {
      return {
        version: 1,
        sessionKey: "",
        messages: [],
        queue: [],
      };
    }
    const parsed = JSON.parse(raw) as Partial<PersistedChatState>;
    const messages = Array.isArray(parsed?.messages)
      ? parsed.messages.map(sanitizeMessage).filter((msg): msg is ChatMessage => Boolean(msg)).slice(-MAX_STORED_MESSAGES)
      : [];
    const queue = Array.isArray(parsed?.queue)
      ? parsed.queue.filter((v): v is string => typeof v === "string" && v.trim().length > 0).slice(-MAX_STORED_QUEUE)
      : [];
    return {
      version: 1,
      sessionKey: typeof parsed?.sessionKey === "string" ? parsed.sessionKey : "",
      messages,
      queue,
    };
  } catch {
    return {
      version: 1,
      sessionKey: "",
      messages: [],
      queue: [],
    };
  }
}

export function savePersistedChatState(state: {
  sessionKey: string;
  messages: ChatMessage[];
  queue: string[];
}): void {
  try {
    const payload: PersistedChatState = {
      version: 1,
      sessionKey: state.sessionKey || "",
      messages: state.messages.slice(-MAX_STORED_MESSAGES),
      queue: state.queue.slice(-MAX_STORED_QUEUE),
    };
    localStorage.setItem(CHAT_STATE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage may be full or disabled
  }
}

export function loadChatDraft(): string {
  try {
    const raw = localStorage.getItem(CHAT_DRAFT_KEY);
    return typeof raw === "string" ? raw.slice(0, MAX_DRAFT_CHARS) : "";
  } catch {
    return "";
  }
}

export function saveChatDraft(value: string): void {
  try {
    const next = value.slice(0, MAX_DRAFT_CHARS);
    if (!next) {
      localStorage.removeItem(CHAT_DRAFT_KEY);
      return;
    }
    localStorage.setItem(CHAT_DRAFT_KEY, next);
  } catch {
    // localStorage may be full or disabled
  }
}
