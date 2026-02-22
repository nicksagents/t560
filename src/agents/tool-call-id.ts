import { createHash } from "node:crypto";
import type { Message } from "@mariozechner/pi-ai";

export type ToolCallIdMode = "strict" | "strict9";

const STRICT9_LEN = 9;
const TOOL_CALL_TYPES = new Set(["toolCall", "toolUse", "functionCall"]);

export type ToolCallLike = {
  id: string;
  name?: string;
};

export function sanitizeToolCallId(id: string, mode: ToolCallIdMode = "strict"): string {
  if (!id || typeof id !== "string") {
    return mode === "strict9" ? "defaultid" : "defaulttoolid";
  }

  if (mode === "strict9") {
    const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, "");
    if (alphanumericOnly.length >= STRICT9_LEN) {
      return alphanumericOnly.slice(0, STRICT9_LEN);
    }
    if (alphanumericOnly.length > 0) {
      return shortHash(alphanumericOnly, STRICT9_LEN);
    }
    return shortHash("sanitized", STRICT9_LEN);
  }

  const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, "");
  return alphanumericOnly.length > 0 ? alphanumericOnly : "sanitizedtoolid";
}

export function makeUniqueToolCallId(params: {
  id: string;
  used: Set<string>;
  mode: ToolCallIdMode;
}): string {
  if (params.mode === "strict9") {
    const base = sanitizeToolCallId(params.id, params.mode);
    const candidate = base.length >= STRICT9_LEN ? base.slice(0, STRICT9_LEN) : "";
    if (candidate && !params.used.has(candidate)) {
      return candidate;
    }

    for (let i = 0; i < 1000; i += 1) {
      const hashed = shortHash(`${params.id}:${i}`, STRICT9_LEN);
      if (!params.used.has(hashed)) {
        return hashed;
      }
    }

    return shortHash(`${params.id}:${Date.now()}`, STRICT9_LEN);
  }

  const MAX_LEN = 40;
  const base = sanitizeToolCallId(params.id, params.mode).slice(0, MAX_LEN);
  if (!params.used.has(base)) {
    return base;
  }

  const hash = shortHash(params.id);
  const separator = params.mode === "strict" ? "" : "_";
  const maxBaseLen = MAX_LEN - separator.length - hash.length;
  const clippedBase = base.length > maxBaseLen ? base.slice(0, maxBaseLen) : base;
  const candidate = `${clippedBase}${separator}${hash}`;
  if (!params.used.has(candidate)) {
    return candidate;
  }

  for (let i = 2; i < 1000; i += 1) {
    const suffix = params.mode === "strict" ? `x${i}` : `_${i}`;
    const next = `${candidate.slice(0, MAX_LEN - suffix.length)}${suffix}`;
    if (!params.used.has(next)) {
      return next;
    }
  }

  const ts = params.mode === "strict" ? `t${Date.now()}` : `_${Date.now()}`;
  return `${candidate.slice(0, MAX_LEN - ts.length)}${ts}`;
}

function shortHash(text: string, length = 8): string {
  return createHash("sha1").update(text).digest("hex").slice(0, length);
}

export function extractToolCallsFromAssistant(
  msg: Extract<Message, { role: "assistant" }>,
): ToolCallLike[] {
  const content = msg.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const toolCalls: ToolCallLike[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; id?: unknown; name?: unknown };
    if (typeof rec.id !== "string" || !rec.id) {
      continue;
    }
    if (typeof rec.type === "string" && TOOL_CALL_TYPES.has(rec.type)) {
      toolCalls.push({
        id: rec.id,
        name: typeof rec.name === "string" ? rec.name : undefined,
      });
    }
  }
  return toolCalls;
}

export function extractToolResultId(
  msg: Extract<Message, { role: "toolResult" }>,
): string | null {
  const toolCallId = (msg as { toolCallId?: unknown }).toolCallId;
  if (typeof toolCallId === "string" && toolCallId) {
    return toolCallId;
  }
  const toolUseId = (msg as { toolUseId?: unknown }).toolUseId;
  if (typeof toolUseId === "string" && toolUseId) {
    return toolUseId;
  }
  return null;
}

export function collectToolCallIds(messages: Message[]): Set<string> {
  const used = new Set<string>();
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    if ((msg as { role?: unknown }).role === "assistant") {
      const toolCalls = extractToolCallsFromAssistant(
        msg as Extract<Message, { role: "assistant" }>,
      );
      for (const call of toolCalls) {
        used.add(call.id);
      }
    } else if ((msg as { role?: unknown }).role === "toolResult") {
      const id = extractToolResultId(msg as Extract<Message, { role: "toolResult" }>);
      if (id) {
        used.add(id);
      }
    }
  }
  return used;
}

function rewriteAssistantToolCallIds(params: {
  message: Extract<Message, { role: "assistant" }>;
  resolve: (id: string) => string;
}): Extract<Message, { role: "assistant" }> {
  const content = params.message.content;
  if (!Array.isArray(content)) {
    return params.message;
  }

  let changed = false;
  const next = content.map((block) => {
    if (!block || typeof block !== "object") {
      return block;
    }
    const rec = block as { type?: unknown; id?: unknown };
    const type = rec.type;
    const id = rec.id;
    if (
      (type !== "functionCall" && type !== "toolUse" && type !== "toolCall") ||
      typeof id !== "string" ||
      !id
    ) {
      return block;
    }
    const nextId = params.resolve(id);
    if (nextId === id) {
      return block;
    }
    changed = true;
    return { ...(block as unknown as Record<string, unknown>), id: nextId };
  });

  if (!changed) {
    return params.message;
  }
  return { ...params.message, content: next as typeof params.message.content };
}

function rewriteToolResultIds(params: {
  message: Extract<Message, { role: "toolResult" }>;
  resolve: (id: string) => string;
}): Extract<Message, { role: "toolResult" }> {
  const toolCallId =
    typeof params.message.toolCallId === "string" && params.message.toolCallId
      ? params.message.toolCallId
      : undefined;
  const toolUseId = (params.message as { toolUseId?: unknown }).toolUseId;
  const toolUseIdStr = typeof toolUseId === "string" && toolUseId ? toolUseId : undefined;

  const nextToolCallId = toolCallId ? params.resolve(toolCallId) : undefined;
  const nextToolUseId = toolUseIdStr ? params.resolve(toolUseIdStr) : undefined;

  if (nextToolCallId === toolCallId && nextToolUseId === toolUseIdStr) {
    return params.message;
  }

  return {
    ...params.message,
    ...(nextToolCallId && { toolCallId: nextToolCallId }),
    ...(nextToolUseId && { toolUseId: nextToolUseId }),
  } as Extract<Message, { role: "toolResult" }>;
}

export function sanitizeToolCallIdsForTranscript(
  messages: Message[],
  mode: ToolCallIdMode = "strict",
): Message[] {
  const map = new Map<string, string>();
  const used = new Set<string>();

  const resolve = (id: string) => {
    const existing = map.get(id);
    if (existing) {
      return existing;
    }
    const next = makeUniqueToolCallId({ id, used, mode });
    map.set(id, next);
    used.add(next);
    return next;
  };

  let changed = false;
  const out = messages.map((msg) => {
    if (!msg || typeof msg !== "object") {
      return msg;
    }
    if ((msg as { role?: unknown }).role === "assistant") {
      const updated = rewriteAssistantToolCallIds({
        message: msg as Extract<Message, { role: "assistant" }>,
        resolve,
      });
      if (updated !== msg) {
        changed = true;
      }
      return updated;
    }
    if ((msg as { role?: unknown }).role === "toolResult") {
      const updated = rewriteToolResultIds({
        message: msg as Extract<Message, { role: "toolResult" }>,
        resolve,
      });
      if (updated !== msg) {
        changed = true;
      }
      return updated;
    }
    return msg;
  });

  return changed ? out : messages;
}
