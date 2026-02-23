import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/state.js";
import type { Message } from "@mariozechner/pi-ai";
import {
  repairToolCallInputs,
  repairToolUseResultPairing,
} from "../agents/session-transcript-repair.js";

const SESSIONS_DIRNAME = "sessions";
export const MAX_SESSION_MESSAGES = 40;

function sanitizeSessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return safe.length > 64 ? safe.slice(0, 64) : safe;
}

function resolveSessionPath(sessionId: string): string {
  const stateDir = resolveStateDir();
  const sessionsDir = path.join(stateDir, SESSIONS_DIRNAME);
  const filename = `${sanitizeSessionId(sessionId)}.json`;
  return path.join(sessionsDir, filename);
}

function coerceMessageArray(raw: unknown): Message[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item) => item && typeof item === "object" && "role" in item) as Message[];
}

function isRole(
  msg: Message,
  role: "assistant" | "toolResult" | "user" | "system",
): boolean {
  return Boolean(msg && typeof msg === "object" && (msg as { role?: unknown }).role === role);
}

function isProviderErrorAssistantStub(msg: Message): boolean {
  if (!isRole(msg, "assistant")) {
    return false;
  }
  const assistant = msg as Extract<Message, { role: "assistant" }> & {
    stopReason?: unknown;
    errorMessage?: unknown;
  };
  if (assistant.stopReason !== "error") {
    return false;
  }
  if (Array.isArray(assistant.content) && assistant.content.length > 0) {
    return false;
  }
  return true;
}

function sanitizeSessionTranscript(messages: Message[]): Message[] {
  // Drop empty provider-error assistant stubs that can poison future rounds.
  const withoutErrorStubs = messages.filter((msg) => !isProviderErrorAssistantStub(msg));

  // Repair malformed tool-call blocks before pairing results.
  const repairedInputs = repairToolCallInputs(withoutErrorStubs).messages;
  const repairedPairing = repairToolUseResultPairing(repairedInputs, {
    allowSyntheticToolResults: false,
  }).messages;

  // Never start a persisted transcript with a tool result.
  let start = 0;
  while (start < repairedPairing.length && isRole(repairedPairing[start] as Message, "toolResult")) {
    start += 1;
  }
  return start > 0 ? repairedPairing.slice(start) : repairedPairing;
}

export async function loadSessionMessages(sessionId: string): Promise<Message[]> {
  const sessionPath = resolveSessionPath(sessionId);
  try {
    const raw = await readFile(sessionPath, "utf-8");
    const parsed = coerceMessageArray(JSON.parse(raw));
    return sanitizeSessionTranscript(parsed);
  } catch {
    return [];
  }
}

export async function saveSessionMessages(sessionId: string, messages: Message[]): Promise<void> {
  const sessionPath = resolveSessionPath(sessionId);
  const sessionsDir = path.dirname(sessionPath);
  await mkdir(sessionsDir, { recursive: true });

  const sanitized = sanitizeSessionTranscript(messages);
  const trimmed =
    sanitized.length > MAX_SESSION_MESSAGES
      ? sanitized.slice(sanitized.length - MAX_SESSION_MESSAGES)
      : sanitized;
  const safeTrimmed = sanitizeSessionTranscript(trimmed);

  await writeFile(sessionPath, JSON.stringify(safeTrimmed, null, 2), "utf-8");
}

export async function clearSessionMessages(sessionId: string): Promise<void> {
  const sessionPath = resolveSessionPath(sessionId);
  try {
    await unlink(sessionPath);
  } catch {
    // no-op
  }
}
