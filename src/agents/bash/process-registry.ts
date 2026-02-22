import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type ProcessStatus = "running" | "completed" | "failed" | "killed" | "timeout";

export type ProcessSession = {
  id: string;
  scopeKey?: string;
  command: string;
  cwd: string;
  shell?: string;
  login?: boolean;
  pty?: boolean;
  ptyWarning?: string;
  startedAt: number;
  endedAt?: number;
  child: ChildProcessWithoutNullStreams;
  pid?: number;
  backgrounded: boolean;
  exited: boolean;
  status: ProcessStatus;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stdout: string[];
  stderr: string[];
  stdoutChars: number;
  stderrChars: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutOffset: number;
  stderrOffset: number;
};

const MAX_BUFFERED_CHUNKS = 3000;
const MAX_BUFFERED_CHARS = 1_000_000;
const DEFAULT_FINISHED_TTL_MS = 15 * 60 * 1000;
const running = new Map<string, ProcessSession>();
const finished = new Map<string, ProcessSession>();
let finishedTtlMs = DEFAULT_FINISHED_TTL_MS;

export function setJobTtlMs(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs < 1000) {
    return;
  }
  finishedTtlMs = Math.floor(ttlMs);
}

export function createProcessId(): string {
  return `proc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function registerProcess(session: ProcessSession): void {
  running.set(session.id, session);
}

export function getSession(sessionId: string): ProcessSession | undefined {
  return running.get(sessionId);
}

export function getFinishedSession(sessionId: string): ProcessSession | undefined {
  return finished.get(sessionId);
}

export function listRunningSessions(): ProcessSession[] {
  return [...running.values()];
}

export function listFinishedSessions(): ProcessSession[] {
  pruneFinishedSessions();
  return [...finished.values()];
}

export function deleteSession(sessionId: string): void {
  running.delete(sessionId);
  finished.delete(sessionId);
}

export function markExited(
  session: ProcessSession,
  exitCode: number | null,
  exitSignal: NodeJS.Signals | null,
  status?: ProcessStatus
): void {
  session.exited = true;
  session.exitCode = exitCode;
  session.exitSignal = exitSignal;
  session.endedAt = Date.now();
  session.status =
    status ??
    (exitSignal
      ? "killed"
      : exitCode === 0 || exitCode === null
        ? "completed"
        : "failed");
  running.delete(session.id);
  finished.set(session.id, session);
  scheduleSessionCleanup(session.id);
}

export function pushStdout(session: ProcessSession, chunk: string): void {
  session.stdout.push(chunk);
  session.stdoutChars += chunk.length;
  while (session.stdoutChars > MAX_BUFFERED_CHARS && session.stdout.length > 0) {
    const removed = session.stdout.shift();
    if (removed) {
      session.stdoutChars -= removed.length;
      session.stdoutTruncated = true;
    }
  }
  if (session.stdout.length > MAX_BUFFERED_CHUNKS) {
    const removedChunks = session.stdout.splice(0, session.stdout.length - MAX_BUFFERED_CHUNKS);
    for (const removed of removedChunks) {
      session.stdoutChars -= removed.length;
    }
    session.stdoutTruncated = true;
    session.stdoutOffset = Math.min(session.stdoutOffset, session.stdout.length);
  }
}

export function pushStderr(session: ProcessSession, chunk: string): void {
  session.stderr.push(chunk);
  session.stderrChars += chunk.length;
  while (session.stderrChars > MAX_BUFFERED_CHARS && session.stderr.length > 0) {
    const removed = session.stderr.shift();
    if (removed) {
      session.stderrChars -= removed.length;
      session.stderrTruncated = true;
    }
  }
  if (session.stderr.length > MAX_BUFFERED_CHUNKS) {
    const removedChunks = session.stderr.splice(0, session.stderr.length - MAX_BUFFERED_CHUNKS);
    for (const removed of removedChunks) {
      session.stderrChars -= removed.length;
    }
    session.stderrTruncated = true;
    session.stderrOffset = Math.min(session.stderrOffset, session.stderr.length);
  }
}

export function drainSession(
  session: ProcessSession
): { stdout: string; stderr: string; hadNewOutput: boolean } {
  const newStdout = session.stdout.slice(session.stdoutOffset);
  const newStderr = session.stderr.slice(session.stderrOffset);
  session.stdoutOffset = session.stdout.length;
  session.stderrOffset = session.stderr.length;
  return {
    stdout: newStdout.join(""),
    stderr: newStderr.join(""),
    hadNewOutput: newStdout.length > 0 || newStderr.length > 0
  };
}

function scheduleSessionCleanup(sessionId: string): void {
  const ttl = finishedTtlMs;
  const timer = setTimeout(() => {
    const session = finished.get(sessionId);
    if (!session || !session.endedAt) {
      return;
    }
    if (Date.now() - session.endedAt >= ttl) {
      finished.delete(sessionId);
    }
  }, ttl + 100);
  timer.unref?.();
}

function pruneFinishedSessions(): void {
  const now = Date.now();
  for (const [id, session] of finished.entries()) {
    if (!session.endedAt) {
      continue;
    }
    if (now - session.endedAt >= finishedTtlMs) {
      finished.delete(id);
    }
  }
}
