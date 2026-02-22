import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import {
  CombinedAutocompleteProvider,
  Container,
  Loader,
  ProcessTerminal,
  Text,
  TUI,
} from "@mariozechner/pi-tui";
import type { AgentEvent } from "../agents/agent-events.js";
import { clearArtifactState } from "../agents/artifact-memory.js";
import { ensureStateDir, readConfig, resolveRoutingTarget, resolveStateDir } from "../config/state.js";
import { startGatewayRuntime } from "../gateway/runtime.js";
import { clearSessionMessages, loadSessionMessages } from "../provider/session.js";
import { helpText, parseCommand, getSlashCommands } from "./commands.js";
import { ChatLog } from "./components/chat-log.js";
import { CustomEditor } from "./components/custom-editor.js";
import { editorTheme, theme } from "./theme.js";
import { buildWaitingStatusMessage, defaultWaitingPhrases } from "./waiting.js";

type TraceMode = "none" | "compact" | "full";

type SessionOptions = {
  think: "off" | "low" | "medium" | "high";
  verbose: "off" | "on" | "full";
  reasoning: "off" | "on";
  usage: "off" | "tokens" | "full";
  elevated: "off" | "on" | "ask" | "full";
  activation: "mention" | "always";
};

const DEFAULT_OPTIONS: SessionOptions = {
  think: "off",
  verbose: "off",
  reasoning: "off",
  usage: "off",
  elevated: "off",
  activation: "mention",
};

function formatElapsed(startMs: number): string {
  const totalSeconds = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function normalizeTraceMode(input: string): TraceMode | null {
  const value = input.trim().toLowerCase();
  if (value === "none" || value === "off") {
    return "none";
  }
  if (value === "compact" || value === "on") {
    return "compact";
  }
  if (value === "full") {
    return "full";
  }
  return null;
}

function textFromMessage(message: Message): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const entry = block as Record<string, unknown>;
    if (entry.type === "text" && typeof entry.text === "string") {
      parts.push(entry.text);
    }
  }
  return parts.join("\n").trim();
}

async function listSessionIds(currentSessionId: string): Promise<string[]> {
  const sessionsDir = path.join(resolveStateDir(), "sessions");
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.replace(/\.json$/, "").trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    if (!names.includes(currentSessionId)) {
      names.unshift(currentSessionId);
    }
    return names;
  } catch {
    return [currentSessionId];
  }
}

export async function runTuiRuntime(): Promise<never> {
  await ensureStateDir();
  const gateway = await startGatewayRuntime();

  let currentSessionId = "terminal:local";
  const terminalUserId = "terminal-user";
  const toolTraceRaw = (process.env.T560_TOOL_TRACE ?? "").trim().toLowerCase();
  let traceMode: TraceMode =
    toolTraceRaw === "1" || toolTraceRaw === "full"
      ? "full"
      : toolTraceRaw === "0" || toolTraceRaw === "none" || toolTraceRaw === "off"
        ? "none"
        : "compact";

  let toolsExpanded = false;
  let connectionStatus = "connected";
  let activityStatus = "idle";
  let statusStartedAt: number | null = null;
  let waitingTick = 0;
  let waitingPhrase = defaultWaitingPhrases[Math.floor(Math.random() * defaultWaitingPhrases.length)] ?? "waiting";
  let waitingTimer: NodeJS.Timeout | null = null;
  let lastCtrlCAt = 0;
  let terminalBusy = false;

  const modelOverrides = new Map<string, string>();
  const sessionOptions = new Map<string, SessionOptions>();

  const resolveSessionOptions = (sessionId: string): SessionOptions => {
    const existing = sessionOptions.get(sessionId);
    if (existing) {
      return existing;
    }
    const next = { ...DEFAULT_OPTIONS };
    sessionOptions.set(sessionId, next);
    return next;
  };

  let options = resolveSessionOptions(currentSessionId);

  const tui = new TUI(new ProcessTerminal());
  const root = new Container();
  const header = new Text("", 1, 0);
  const chatLog = new ChatLog();
  const statusContainer = new Container();
  const footer = new Text("", 1, 0);
  const editor = new CustomEditor(tui, editorTheme);

  root.addChild(header);
  root.addChild(chatLog);
  root.addChild(statusContainer);
  root.addChild(footer);
  root.addChild(editor);
  tui.addChild(root);
  tui.setFocus(editor);

  const statusText = new Text("", 1, 0);
  let statusLoader: Loader | null = null;
  statusContainer.addChild(statusText);

  const updateHeader = () => {
    const sessionLabel = currentSessionId;
    header.setText(theme.header(`t560 tui - ${gateway.dashboard.localUrl} - ${gateway.mode} - session ${sessionLabel}`));
  };

  const resolveModelLabel = () => {
    const override = modelOverrides.get(currentSessionId);
    if (override) {
      return override;
    }
    return gateway.providerLabel;
  };

  const updateFooter = () => {
    const model = resolveModelLabel();
    const parts = [
      "agent main",
      `session ${currentSessionId}`,
      model || "unknown",
      options.think !== "off" ? `think ${options.think}` : null,
      options.reasoning === "on" ? "reasoning" : null,
      options.verbose !== "off" ? `verbose ${options.verbose}` : null,
      options.usage !== "off" ? `usage ${options.usage}` : null,
      `trace ${traceMode}`,
      toolsExpanded ? "tools expanded" : "tools collapsed",
      "ctrl+c twice exits",
    ].filter(Boolean);
    footer.setText(theme.dim(parts.join(" | ")));
  };

  const renderStatus = () => {
    if (!terminalBusy) {
      if (waitingTimer) {
        clearInterval(waitingTimer);
        waitingTimer = null;
      }
      if (statusLoader) {
        statusLoader.stop();
        statusContainer.clear();
        statusContainer.addChild(statusText);
        statusLoader = null;
      }
      statusStartedAt = null;
      statusText.setText(theme.dim(`${connectionStatus} | ${activityStatus}`));
      return;
    }

    if (!statusLoader) {
      statusContainer.clear();
      statusLoader = new Loader(
        tui,
        (spinner) => theme.accent(spinner),
        (text) => theme.bold(theme.accentSoft(text)),
        "",
      );
      statusContainer.addChild(statusLoader);
      statusStartedAt = Date.now();
    }

    if (!waitingTimer) {
      waitingTimer = setInterval(() => {
        if (!terminalBusy || !statusLoader || !statusStartedAt) {
          return;
        }
        waitingTick += 1;
        const elapsed = formatElapsed(statusStartedAt);
        const message =
          activityStatus === "waiting"
            ? buildWaitingStatusMessage({
                theme,
                tick: waitingTick,
                elapsed,
                connectionStatus,
                phrase: waitingPhrase,
              })
            : `${activityStatus} • ${elapsed} | ${connectionStatus}`;
        statusLoader.setMessage(message);
        tui.requestRender();
      }, 120);
    }
  };

  const setActivityStatus = (text: string) => {
    activityStatus = text;
    renderStatus();
    updateFooter();
    tui.requestRender();
  };

  const setConnectionStatus = (text: string) => {
    connectionStatus = text;
    renderStatus();
    updateFooter();
    tui.requestRender();
  };

  const addSystem = (text: string) => {
    chatLog.addSystem(text);
    tui.requestRender();
  };

  const loadHistory = async () => {
    const history = await loadSessionMessages(currentSessionId);
    chatLog.clearAll();
    for (const message of history) {
      if (message.role === "user") {
        const text = textFromMessage(message);
        if (text) {
          chatLog.addUser(text);
        }
        continue;
      }
      if (message.role === "assistant") {
        const text = textFromMessage(message);
        if (text) {
          chatLog.finalizeAssistant(text);
