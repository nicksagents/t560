import { createInterface } from "node:readline";
import { theme, isRich } from "../cli/theme.js";
import { ensureStateDir } from "../config/state.js";
import {
  formatTerminalResponse,
  formatWaitingStatus,
  formatElapsed,
  formatFooter,
  formatTerminalToolEvent,
} from "../format/message-formatter.js";
import { isHeartbeatCheckMessage } from "../gateway/heartbeat.js";
import { startGatewayRuntime } from "../gateway/runtime.js";
import type { AgentEvent } from "../agents/agent-events.js";
import { approvePairingCode, listPendingPairings } from "../channels/pairing.js";
import { getSetupFlowState, handleSecureSetupFlow } from "../security/setup-flow.js";

function createTerminalSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `terminal:${ts}-${rand}`;
}

type PairingCommand =
  | { action: "approve"; channel: string; code: string }
  | { action: "list"; channel: string };

function parsePairingCommand(raw: string): PairingCommand | null {
  const input = raw.trim();
  if (!input) {
    return null;
  }

  const pairSlash = /^\/pair(?:\s+(telegram)\s+([a-z0-9]+)|\s+([a-z0-9]+))?$/i.exec(input);
  if (pairSlash) {
    const code = (pairSlash[2] ?? pairSlash[3] ?? "").trim().toUpperCase();
    if (!code) {
      return { action: "list", channel: "telegram" };
    }
    return { action: "approve", channel: "telegram", code };
  }

  const approve =
    /^(?:t560\s+)?pair(?:ing)?\s+approve\s+([a-z0-9_-]+)\s+([a-z0-9]+)$/i.exec(input);
  if (approve) {
    return {
      action: "approve",
      channel: approve[1].toLowerCase(),
      code: approve[2].toUpperCase(),
    };
  }

  const list = /^(?:t560\s+)?pair(?:ing)?\s+list(?:\s+([a-z0-9_-]+))?$/i.exec(input);
  if (list) {
    return { action: "list", channel: (list[1] ?? "telegram").toLowerCase() };
  }

  return null;
}

function renderTerminalMenuBar(params: {
  rich: boolean;
  sessionId: string;
  busy: boolean;
}): string {
  const setupState = getSetupFlowState(params.sessionId);
  const status = params.busy
    ? "processing"
    : setupState
      ? setupState.step === "identifier"
        ? `setup ${setupState.service}: waiting for account identifier`
        : setupState.step === "authMode"
          ? `setup ${setupState.service}: waiting for auth mode (password|mfa)`
          : setupState.authMode === "passwordless_mfa_code"
            ? `setup ${setupState.service}: waiting for MFA code or skip`
            : `setup ${setupState.service}: waiting for app password`
      : "ready";

  const commands = setupState
    ? "/setup cancel | /setup list | /pair <CODE>"
    : "/setup <service-or-site> | /setup list | /pair <CODE>";
  const text = `menu ${status} | ${commands}`;
  return params.rich ? theme.dim(text) : text;
}

export async function runAgentRuntime(): Promise<never> {
  await ensureStateDir();
  const gateway = await startGatewayRuntime();
  const rich = isRich();
  let terminalBusy = false;

  // ── Header (OpenClaw-style: bold accent, one-line summary) ──────────
  const headerLine = rich
    ? theme.header(`t560 — ${gateway.dashboard.localUrl} — ${gateway.mode}`)
    : `t560 — ${gateway.dashboard.localUrl} — ${gateway.mode}`;
  process.stdout.write(`\n${headerLine}\n`);

  // ── Status panel ────────────────────────────────────────────────────
  if (gateway.dashboard.tailscaleUrl) {
    process.stdout.write(
      `${rich ? theme.dim("tailscale") : "tailscale"} ${rich ? theme.info(gateway.dashboard.tailscaleUrl) : gateway.dashboard.tailscaleUrl}\n`
    );
  }
  if (gateway.mode === "provider") {
    process.stdout.write(
      `${rich ? theme.dim("route") : "route"} ${rich ? theme.fg(gateway.providerLabel) : gateway.providerLabel}\n`
    );
  } else {
    process.stdout.write(
      `${rich ? theme.dim("missing") : "missing"} ${gateway.onboardingMissing.join(", ")}\n`
    );
  }
  process.stdout.write(
    `${rich ? theme.dim("telegram") : "telegram"} ${rich ? theme.fg(gateway.telegram.info) : gateway.telegram.info}\n`
  );
  if (gateway.dangerouslyUnrestricted) {
    process.stdout.write(
      `${rich ? theme.warn("warning") : "warning"} ${
        rich ? theme.fg("dangerously unrestricted mode enabled: shell and filesystem actions can be destructive.") : "dangerously unrestricted mode enabled: shell and filesystem actions can be destructive."
      }\n`
    );
  }

  // ── Footer bar ──────────────────────────────────────────────────────
  const footer = formatFooter({
    mode: gateway.mode,
    provider: gateway.mode === "provider" ? gateway.providerLabel.split("/")[0] : null,
    model: gateway.mode === "provider" ? gateway.providerLabel.split("/")[1] : null,
  });
  const cols = process.stdout.columns || 60;
  process.stdout.write(`${rich ? theme.border("─".repeat(cols)) : "─".repeat(cols)}\n`);
  process.stdout.write(`${footer}\n\n`);

  // ── Terminal readline ───────────────────────────────────────────────
  const terminalRl = process.stdin.isTTY
    ? createInterface({
        input: process.stdin,
        output: process.stdout,
      })
    : null;

  if (terminalRl) {
    const TERMINAL_SESSION_ID = createTerminalSessionId();
    const TERMINAL_USER_ID = "terminal-user";
    let maskSecretInput = false;
    const rlWithMask = terminalRl as typeof terminalRl & {
      _writeToOutput?: (chunk: string) => void;
    };
    const originalWriteToOutput =
      typeof rlWithMask._writeToOutput === "function"
        ? rlWithMask._writeToOutput.bind(terminalRl)
        : null;
    if (originalWriteToOutput) {
      rlWithMask._writeToOutput = (chunk: string) => {
        if (!maskSecretInput) {
          originalWriteToOutput(chunk);
          return;
        }
        const isPromptChunk = chunk.includes(terminalRl.getPrompt());
        const isControlChunk =
          chunk.includes("\n") ||
          chunk.includes("\r") ||
          chunk.includes("\u0008") ||
          chunk.includes("\u001b");
        if (isPromptChunk || isControlChunk) {
          originalWriteToOutput(chunk);
          return;
        }
        originalWriteToOutput("*");
      };
    }

    // System message like OpenClaw's chatLog.addSystem()
    process.stdout.write(
      `${rich ? theme.system(`started new session: ${TERMINAL_SESSION_ID}`) : `started new session: ${TERMINAL_SESSION_ID}`}\n\n`
    );
    process.stdout.write(
      `${rich ? theme.dim("pairing tip: use /pair <CODE> or t560 pairing approve telegram <CODE>") : "pairing tip: use /pair <CODE> or t560 pairing approve telegram <CODE>"}\n\n`
    );
    process.stdout.write(
      `${rich ? theme.dim("setup tip: use /setup <service-or-site> (example: /setup havenvaults2-0)") : "setup tip: use /setup <service-or-site> (example: /setup havenvaults2-0)"}\n\n`
    );

    let waitingStatus = "";
    let waitingActive = false;

    const clearWaitingLine = () => {
      if (waitingActive) {
        process.stdout.write("\r\x1b[K");
      }
    };
    const restoreWaitingLine = () => {
      if (waitingActive && waitingStatus) {
        process.stdout.write(`\r\x1b[K${waitingStatus}`);
      }
    };
    const renderMenu = () => {
      const cols = process.stdout.columns || 60;
      const divider = rich ? theme.border("─".repeat(cols)) : "─".repeat(cols);
      const menuLine = renderTerminalMenuBar({
        rich,
        sessionId: TERMINAL_SESSION_ID,
        busy: terminalBusy,
      });
      process.stdout.write(`${divider}\n${menuLine}\n`);
    };
    const promptWithMenu = () => {
      const setupState = getSetupFlowState(TERMINAL_SESSION_ID);
      maskSecretInput = Boolean(setupState && setupState.step === "secret");
      terminalRl.setPrompt(
        maskSecretInput
          ? rich
            ? theme.accent("🔒 ")
            : "[secret] "
          : rich
            ? theme.accent("❯ ")
            : "> "
      );
      renderMenu();
      terminalRl.prompt();
    };

    const handleToolEvent = (event: AgentEvent) => {
      if (!terminalBusy) {
        return;
      }
      const rendered = formatTerminalToolEvent(event);
      if (!rendered) {
        return;
      }
      clearWaitingLine();
      process.stdout.write(`${rendered}\n`);
      restoreWaitingLine();
    };

    const unsubscribeEvents = gateway.subscribeEvents({
      sessionId: TERMINAL_SESSION_ID,
      onEvent: handleToolEvent,
    });

    promptWithMenu();

    terminalRl.on("line", async (line) => {
      const rawMessage = line;
      const message = rawMessage.trim();
      if (!message) {
        promptWithMenu();
        return;
      }
      if (isHeartbeatCheckMessage(message)) {
        promptWithMenu();
        return;
      }
      const setupHandled = await handleSecureSetupFlow({
        sessionId: TERMINAL_SESSION_ID,
        message: rawMessage,
      });
      if (setupHandled.handled) {
        process.stdout.write(
          `${rich ? theme.system(setupHandled.message) : setupHandled.message}\n\n`
        );
        promptWithMenu();
        return;
      }
      const pairingCommand = parsePairingCommand(message);
      if (pairingCommand) {
        try {
          if (pairingCommand.action === "list") {
            const pending = await listPendingPairings({ channel: pairingCommand.channel });
            if (pending.length === 0) {
              process.stdout.write(
                `${rich ? theme.system(`No pending ${pairingCommand.channel} pairing requests.`) : `No pending ${pairingCommand.channel} pairing requests.`}\n\n`
              );
            } else {
              process.stdout.write(
                `${rich ? theme.system(`Pending ${pairingCommand.channel} pairing requests:`) : `Pending ${pairingCommand.channel} pairing requests:`}\n`
              );
              for (const entry of pending) {
                process.stdout.write(
                  `${rich ? theme.dim(`- code=${entry.code} user=${entry.userId} chat=${entry.chatId}`) : `- code=${entry.code} user=${entry.userId} chat=${entry.chatId}`}\n`
                );
              }
              process.stdout.write("\n");
            }
          } else {
            const approved = await approvePairingCode({
              channel: pairingCommand.channel,
              code: pairingCommand.code,
            });
            if (!approved) {
              process.stdout.write(
                `${rich ? theme.warn(`No pending ${pairingCommand.channel} request for code ${pairingCommand.code}.`) : `No pending ${pairingCommand.channel} request for code ${pairingCommand.code}.`}\n`
              );
              process.stdout.write(
                `${rich ? theme.dim(`Try: t560 pairing list ${pairingCommand.channel}`) : `Try: t560 pairing list ${pairingCommand.channel}`}\n\n`
              );
            } else {
              process.stdout.write(
                `${rich ? theme.success(`Approved ${pairingCommand.channel} code ${approved.code}.`) : `Approved ${pairingCommand.channel} code ${approved.code}.`}\n`
              );
              process.stdout.write(
                `${rich ? theme.dim(`user=${approved.userId} chat=${approved.chatId}`) : `user=${approved.userId} chat=${approved.chatId}`}\n\n`
              );
            }
          }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          process.stderr.write(`${rich ? theme.error(`pairing error: ${msg}`) : `pairing error: ${msg}`}\n\n`);
        }
        promptWithMenu();
        return;
      }
      if (terminalBusy) {
        process.stdout.write(`${rich ? theme.dim("waiting for previous response…") : "waiting for previous response..."}\n`);
        promptWithMenu();
        return;
      }

      terminalBusy = true;

      // Shimmer waiting animation (OpenClaw tui-waiting.ts)
      let tick = 0;
      const startMs = Date.now();
      waitingActive = true;
      const waitingInterval = setInterval(() => {
        const elapsed = formatElapsed(startMs);
        const status = formatWaitingStatus(tick, elapsed);
        waitingStatus = status;
        process.stdout.write(`\r\x1b[K${status}`);
        tick++;
      }, 80);

      try {
        const reply = await gateway.handleMessage({
          channel: "terminal",
          message,
          sessionId: TERMINAL_SESSION_ID,
          externalUserId: TERMINAL_USER_ID,
          receivedAt: Date.now(),
        });

        clearInterval(waitingInterval);
        waitingActive = false;
        waitingStatus = "";
        process.stdout.write("\r\x1b[K");

        // Render assistant response (OpenClaw AssistantMessageComponent style)
        process.stdout.write(formatTerminalResponse(reply) + "\n\n");
      } catch (error: unknown) {
        clearInterval(waitingInterval);
        waitingActive = false;
        waitingStatus = "";
        process.stdout.write("\r\x1b[K");
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `${rich ? theme.error(`error: ${msg}`) : `error: ${msg}`}\n\n`
        );
      } finally {
        terminalBusy = false;
        promptWithMenu();
      }
    });

    process.once("SIGINT", () => unsubscribeEvents());
    process.once("SIGTERM", () => unsubscribeEvents());
  }

  // ── Shutdown ────────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    terminalRl?.close();
    process.stdout.write(
      `\n${rich ? theme.warn(signal) : signal} ${rich ? theme.dim("shutting down t560") : "shutting down t560"}\n`
    );
    gateway.close().finally(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  return await new Promise<never>(() => {});
}
