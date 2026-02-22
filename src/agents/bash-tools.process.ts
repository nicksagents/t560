import { Type } from "@mariozechner/pi-ai";
import type { AnyAgentTool } from "./pi-tools.types.js";
import type { ProcessSession } from "./bash-process-registry.js";
import {
  deleteSession,
  drainSession,
  getFinishedSession,
  getSession,
  listFinishedSessions,
  listRunningSessions,
  setJobTtlMs
} from "./bash-process-registry.js";

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

function resolveProcessStatus(session: ProcessSession): "running" | "completed" | "failed" {
  if (!session.exited) {
    return "running";
  }
  if ((session.exitCode ?? 0) === 0 && !session.exitSignal) {
    return "completed";
  }
  return "failed";
}

export function createProcessTool(defaults?: ProcessToolDefaults): AnyAgentTool {
  if (typeof defaults?.cleanupMs === "number") {
    setJobTtlMs(defaults.cleanupMs);
  }
  const scopeKey = defaults?.scopeKey;

  return {
    name: "process",
    description:
      "Manage exec sessions: list, poll, log, write, submit, kill, clear, remove.",
    parameters: Type.Object({
      action: Type.String({ description: "Process action." }),
      sessionId: Type.Optional(Type.String({ description: "Session id for actions other than list." })),
      data: Type.Optional(Type.String({ description: "Data to write to stdin." })),
      eof: Type.Optional(Type.Boolean({ description: "Close stdin after write/submit." })),
      offset: Type.Optional(Type.Number({ description: "Line offset for log." })),
      limit: Type.Optional(Type.Number({ description: "Line limit for log." })),
      timeout: Type.Optional(Type.Number({ description: "Poll wait time (ms).", minimum: 0, maximum: 120000 }))
    }),
    execute: async (_toolCallId, params) => {
      const action = String(params.action ?? "list").trim().toLowerCase();

      if (action === "list") {
        const running = listRunningSessions()
          .filter((session) => isInScope(scopeKey, session.scopeKey))
          .map((session) => ({
            sessionId: session.id,
            status: "running",
            pid: session.pid,
            command: session.command,
            cwd: session.cwd,
            startedAt: session.startedAt
          }));
        const finished = listFinishedSessions()
          .filter((session) => isInScope(scopeKey, session.scopeKey))
          .map((session) => ({
            sessionId: session.id,
            status: session.status,
            command: session.command,
            cwd: session.cwd,
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

      if (action === "poll") {
        if (!scopedRunning) {
          if (!scopedFinished) {
            return {
              content: [{ type: "text", text: `No session found for ${sessionId}.` }],
              details: { status: "failed" }
            };
          }
          const text = scopedFinished.aggregated || "(no output)";
          return {
            content: [{ type: "text", text }],
            details: {
              status: scopedFinished.status === "completed" ? "completed" : "failed",
              sessionId,
              exitCode: scopedFinished.exitCode,
              exitSignal: scopedFinished.exitSignal
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
        const text = [drained.stdout, drained.stderr].filter(Boolean).join("") || "(no new output)";
        return {
          content: [{ type: "text", text }],
          details: {
            status: resolveProcessStatus(scopedRunning),
            sessionId,
            running: !scopedRunning.exited,
            exitCode: scopedRunning.exitCode,
            exitSignal: scopedRunning.exitSignal
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
        const all = target.aggregated;
        const lines = all.split(/\r?\n/);
        const offset = Math.max(0, Number(params.offset ?? 0));
        const limitRaw = Number(params.limit ?? 200);
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(2000, Math.floor(limitRaw))) : 200;
        const sliced = lines.slice(offset, offset + limit).join("\n");
        return {
          content: [{ type: "text", text: sliced || "(no log output)" }],
          details: {
            status: "completed",
            sessionId,
            offset,
            limit,
            totalLines: lines.length
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
        const stdin = scopedRunning.stdin;
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
        if (scopedRunning?.child) {
          scopedRunning.child.kill("SIGTERM");
          return {
            content: [{ type: "text", text: `Sent SIGTERM to ${sessionId}.` }],
            details: { status: "completed", sessionId, killed: true }
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
        content: [{ type: "text", text: "Unknown process action. Use list, poll, log, write, submit, paste, kill, clear, or remove." }],
        details: { status: "failed" }
      };
    }
  };
}

export const processTool = createProcessTool();
