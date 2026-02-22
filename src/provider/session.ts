import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/state.js";
import type { Message } from "@mariozechner/pi-ai";

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

export async function loadSessionMessages(sessionId: string): Promise<Message[]> {
  const sessionPath = resolveSessionPath(sessionId);
  try {
    const raw = await readFile(sessionPath, "utf-8");
    return coerceMessageArray(JSON.parse(raw));
  } catch {
    return [];
  }
}

export async function saveSessionMessages(sessionId: string, messages: Message[]): Promise<void> {
  const sessionPath = resolveSessionPath(sessionId);
  const sessionsDir = path.dirname(sessionPath);
  await mkdir(sessionsDir, { recursive: true });

  const trimmed =
    messages.length > MAX_SESSION_MESSAGES
      ? messages.slice(messages.length - MAX_SESSION_MESSAGES)
      : messages;

  await writeFile(sessionPath, JSON.stringify(trimmed, null, 2), "utf-8");
}

export async function clearSessionMessages(sessionId: string): Promise<void> {
  const sessionPath = resolveSessionPath(sessionId);
  try {
    await unlink(sessionPath);
  } catch {
    // no-op
  }
}
