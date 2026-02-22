import { exec as execCallback } from "node:child_process";
import { Type } from "@mariozechner/pi-ai";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { assertExecCommandAllowed, type SelfProtectionPolicy } from "./self-protection.js";

export type ExecToolDefaults = {
  cwd?: string;
  timeoutSec?: number;
  allowBackground?: boolean;
  selfProtection?: SelfProtectionPolicy;
};

function toErrorMessage(error: unknown): string {
  if (!error) {
    return "Unknown exec failure.";
  }
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return String(error);
}

export function createExecTool(defaults?: ExecToolDefaults): AnyAgentTool {
  const defaultCwd = defaults?.cwd ?? process.cwd();
  const timeoutSec = typeof defaults?.timeoutSec === "number" && defaults.timeoutSec > 0
    ? defaults.timeoutSec
    : 180;
  const allowBackground = defaults?.allowBackground !== false;
  const selfProtection = defaults?.selfProtection;

  return {
    name: "exec",
    description: "Execute a shell command.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run." }),
      workdir: Type.Optional(Type.String({ description: "Working directory." })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds." })),
      background: Type.Optional(Type.Boolean({ description: "Run in background (best effort)." })),
    }),
    execute: async (_toolCallId, params) => {
      const command = String(params.command ?? "").trim();
      if (!command) {
        throw new Error("Provide a command to run.");
      }

      const cwd = String(params.workdir ?? defaultCwd).trim() || defaultCwd;
      const timeout =
        typeof params.timeout === "number" && Number.isFinite(params.timeout) && params.timeout > 0
          ? Math.floor(params.timeout)
          : timeoutSec;
      const background = params.background === true;

      if (selfProtection) {
        assertExecCommandAllowed({
          command,
          cwd,
          policy: selfProtection
        });
      }

      if (background && !allowBackground) {
        throw new Error("Background execution is disabled.");
      }

      // Recovery build: run synchronously even when background=true.
      return await new Promise<unknown>((resolve, reject) => {
        execCallback(
          command,
          {
            cwd,
            timeout: timeout * 1000,
            maxBuffer: 2 * 1024 * 1024,
            shell: true,
            env: process.env,
          },
          (error, stdout, stderr) => {
            const out = String(stdout ?? "");
            const err = String(stderr ?? "");

            if (error) {
              const base = toErrorMessage(error);
              const payload = [
                base,
                err.trim() ? `stderr:\n${err.trim()}` : "",
                out.trim() ? `stdout:\n${out.trim()}` : "",
              ]
                .filter(Boolean)
                .join("\n\n");
              reject(new Error(payload));
              return;
            }

            resolve({
              status: "completed",
              command,
              cwd,
              background,
              stdout: out,
              stderr: err,
            });
          },
        );
      });
    },
  };
}

export const execTool = createExecTool();
