import { Type } from "@mariozechner/pi-ai";
import type { AnyAgentTool } from "../pi-tools.types.js";
import {
  deleteSession,
  drainSession,
  getFinishedSession,
  getSession,
  listFinishedSessions,
  listRunningSessions,
  setJobTtlMs
} from "./process-registry.js";

export type ProcessToolDefaults = {
  cleanupMs?: number;
  scopeKey?: string;
};

function isInScope(scopeKey: string | undefined, sessionScopeKey: string | undefined): boolean {
  if (!scopeKey) {
    return true;
  }
  return scopeKey === sessionScopeKey;
}

function renderSessionSummary(params: {
  id: string;
  status: string;
  command: string;
  startedAt: number;
  endedAt?: number;
}): string {
  const runtimeMs = (params.endedAt ?? Date.now()) - params.startedAt;
  const seconds = Math.max(0, Math.round(runtimeMs / 1000));
  return `${params.id} ${params.status} ${seconds}s :: ${params.command}`;
}

const VALID_SIGNALS = new Set<NodeJS.Signals>([
  "SIGTERM",
  "SIGKILL",
  "SIGINT",
  "SIGQUIT",
  "SIGHUP",
  "SIGUSR1",
  "SIGUSR2"
]);

export function createProcessTool(defaults?: ProcessToolDefaults): AnyAgentTool {
  if (typeof defaults?.cleanupMs === "number") {
    setJobTtlMs(defaults.cleanupMs);
  }
  const scopeKey = defaults?.scopeKey;

  return {
    name: "process",
    description:
      "Manage exec sessions: list/status, poll/wait, log/tail, write/submit, kill/stop, clear/remove.",
    parameters: Type.Object({
      action: Type.String({ description: "Process action." }),
      sessionId: Type.Optional(Type.String({ description: "Session id for actions other than list." })),
      data: Type.Optional(Type.String({ description: "Data to write to stdin." })),
      eof: Type.Optional(Type.Boolean({ description: "Close stdin after write/submit." })),
      signal: Type.Optional(Type.String({ description: "Signal for kill action (e.g., SIGTERM, SIGKILL)." })),
      offset: Type.Optional(Type.Number({ description: "Line offset for log." })),
      limit: Type.Optional(Type.Number({ description: "Line limit for log." })),
      timeout: Type.Optional(Type.Number({ description: "Poll wait time (ms).", minimum: 0, maximum: 120000 }))
    }),
    execute: async (_toolCallId, params) => {
      const actionInput = String(params.action ?? "list").trim().toLowerCase();
      const action =
        actionInput === "wait"
          ? "poll"
          : actionInput === "tail"
            ? "log"
            : actionInput === "stop"
              ? "kill"
              : actionInput;

      if (action === "list") {
        const running = listRunningSessions()
          .filter((session) => isInScope(scopeKey, session.scopeKey))
          .map((session) => ({
            sessionId: session.id,
            status: "running",
            pid: session.pid,
            command: session.command,
            cwd: session.cwd,
            shell: session.shell,
            login: session.login,
            pty: session.pty,
            ptyWarning: session.ptyWarning,
            startedAt: session.startedAt
          }));
        const finished = listFinishedSessions()
          .filter((session) => isInScope(scopeKey, session.scopeKey))
          .map((session) => ({
            sessionId: session.id,
            status: session.status,
            pid: session.pid,
            command: session.command,
            cwd: session.cwd,
            shell: session.shell,
            login: session.login,
            pty: session.pty,
            ptyWarning: session.ptyWarning,
            startedAt: session.startedAt,
            endedAt: session.endedAt,
            exitCode: session.exitCode,
            exitSignal: session.exitSignal
          }));
        const lines = [...running, ...finished]
          .map((item) =>
            renderSessionSummary({
              id: item.sessionId,
              status: item.status,
              command: item.command,
              startedAt: item.startedAt,
              endedAt: (item as { endedAt?: number }).endedAt
            })
          )
          .join("\n");

        return {
          content: [{ type: "text", text: lines || "No running or recent sessions." }],
          details: {
            status: "completed",
            sessions: [...running, ...finished]
          }
        };
      }

      const sessionId = String(params.sessionId ?? "").trim();
      if (!sessionId) {
        return {
          content: [{ type: "text", text: "sessionId is required for this action." }],
          details: { status: "failed" }
        };
      }

      const running = getSession(sessionId);
      const finished = getFinishedSession(sessionId);
      const scopedRunning = running && isInScope(scopeKey, running.scopeKey) ? running : undefined;
      const scopedFinished = finished && isInScope(scopeKey, finished.scopeKey) ? finished : undefined;

      if (action === "status") {
        const target = scopedRunning ?? scopedFinished;
        if (!target) {
          return {
            content: [{ type: "text", text: `No session found for ${sessionId}.` }],
            details: { status: "failed" }
          };
        }
        const state = target.exited ? target.status : "running";
        const statusLine = `${sessionId} ${state}${target.pid ? ` pid=${target.pid}` : ""} :: ${target.command}`;
        return {
          content: [{ type: "text", text: statusLine }],
          details: {
            status: state,
            sessionId,
            running: !target.exited,
            command: target.command,
            cwd: target.cwd,
            shell: target.shell,
            login: target.login,
            pty: target.pty,
            ptyWarning: target.ptyWarning,
            exitCode: target.exitCode,
            exitSignal: target.exitSignal,
            stdoutTruncated: target.stdoutTruncated,
            stderrTruncated: target.stderrTruncated
          }
        };
      }

      if (action === "poll") {
        if (!scopedRunning) {
          if (!scopedFinished) {
            return {
              content: [{ type: "text", text: `No session found for ${sessionId}.` }],
              details: { status: "failed" }
            };
          }
          const stdout = scopedFinished.stdout.join("");
          const stderr = scopedFinished.stderr.join("");
          const truncationNote =
            scopedFinished.stdoutTruncated || scopedFinished.stderrTruncated
              ? "\n\n[session output was truncated in buffer]"
              : "";
          const text = ([stdout, stderr].filter(Boolean).join("") || "(no output)") + truncationNote;
          return {
            content: [{ type: "text", text }],
            details: {
              status: scopedFinished.status,
              sessionId,
              exitCode: scopedFinished.exitCode,
              exitSignal: scopedFinished.exitSignal,
              stdoutTruncated: scopedFinished.stdoutTruncated,
              stderrTruncated: scopedFinished.stderrTruncated
            }
          };
        }

        const timeoutMs =
          typeof params.timeout === "number"
            ? Math.max(0, Math.min(120_000, Math.floor(params.timeout)))
            : 0;

        if (timeoutMs > 0 && !scopedRunning.exited) {
          const deadline = Date.now() + timeoutMs;
          while (!scopedRunning.exited && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(200, deadline - Date.now())));
          }
        }

        const drained = drainSession(scopedRunning);
        const truncationNote =
          scopedRunning.stdoutTruncated || scopedRunning.stderrTruncated
            ? "\n\n[session output was truncated in buffer]"
            : "";
        const text = ([drained.stdout, drained.stderr].filter(Boolean).join("") || "(no new output)") + truncationNote;
        return {
          content: [{ type: "text", text }],
          details: {
            status: scopedRunning.exited ? scopedRunning.status : "running",
            sessionId,
            running: !scopedRunning.exited,
            exitCode: scopedRunning.exitCode,
            exitSignal: scopedRunning.exitSignal,
            stdoutTruncated: scopedRunning.stdoutTruncated,
            stderrTruncated: scopedRunning.stderrTruncated
          }
        };
      }

      if (action === "log") {
        const target = scopedRunning ?? scopedFinished;
        if (!target) {
          return {
            content: [{ type: "text", text: `No session found for ${sessionId}.` }],
            details: { status: "failed" }
          };
        }
        const stdout = target.stdout.join("");
        const stderr = target.stderr.join("");
        const all = [stdout, stderr].filter(Boolean).join("");
        const lines = all.split(/\r?\n/);
        const offset = Math.max(0, Number(params.offset ?? 0));
        const limitRaw = Number(params.limit ?? 200);
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(2000, Math.floor(limitRaw))) : 200;
        const sliced = lines.slice(offset, offset + limit).join("\n");
        const truncationNote =
          target.stdoutTruncated || target.stderrTruncated
            ? "\n\n[session output was truncated in buffer]"
            : "";
        return {
          content: [{ type: "text", text: (sliced || "(no log output)") + truncationNote }],
          details: {
            status: "completed",
            sessionId,
            offset,
            limit,
            totalLines: lines.length,
            stdoutTruncated: target.stdoutTruncated,
            stderrTruncated: target.stderrTruncated
          }
        };
      }

      if (action === "write" || action === "submit" || action === "paste") {
        if (!scopedRunning) {
          return {
            content: [{ type: "text", text: `No active session found for ${sessionId}.` }],
            details: { status: "failed" }
          };
        }
        const data = String(params.data ?? "");
        const payload = action === "submit" ? `${data}\n` : data;
        if (!payload) {
          return {
            content: [{ type: "text", text: "data is required for write/submit/paste." }],
            details: { status: "failed" }
          };
        }
        const stdin = scopedRunning.child.stdin;
        if (!stdin || stdin.destroyed) {
          return {
            content: [{ type: "text", text: `Session ${sessionId} stdin is not writable.` }],
            details: { status: "failed" }
          };
        }
        await new Promise<void>((resolve, reject) => {
          stdin.write(payload, (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
        if (params.eof === true) {
          stdin.end();
        }
        return {
          content: [{ type: "text", text: `Wrote ${payload.length} bytes to ${sessionId}.` }],
          details: { status: "completed", sessionId }
        };
      }

      if (action === "kill") {
        if (scopedRunning) {
          const signalRaw = String(params.signal ?? "SIGTERM").trim().toUpperCase();
          if (!VALID_SIGNALS.has(signalRaw as NodeJS.Signals)) {
            return {
              content: [{ type: "text", text: `Invalid signal '${signalRaw}'.` }],
              details: { status: "failed", sessionId, killed: false, signal: signalRaw }
            };
          }
          const signal = signalRaw as NodeJS.Signals;
          scopedRunning.child.kill(signal);
          return {
            content: [{ type: "text", text: `Sent ${signal} to ${sessionId}.` }],
            details: { status: "completed", sessionId, killed: true, signal }
          };
        }
        return {
          content: [{ type: "text", text: `Session ${sessionId} is not running.` }],
          details: { status: "failed", sessionId, killed: false }
        };
      }

      if (action === "clear" || action === "remove") {
        deleteSession(sessionId);
        return {
          content: [{ type: "text", text: `Removed session ${sessionId} from registry.` }],
          details: { status: "completed", sessionId }
        };
      }

      return {
        content: [{ type: "text", text: "Unknown process action. Use list, status, poll, wait, log, tail, write, submit, paste, kill, stop, clear, or remove." }],
        details: { status: "failed" }
      };
    }
  };
}

export const processTool = createProcessTool();
