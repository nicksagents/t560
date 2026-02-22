import {
  CombinedAutocompleteProvider,
  type SlashCommand,
  Container,
  ProcessTerminal,
  Text,
  TUI,
} from "@mariozechner/pi-tui";
import type { ChatResponse } from "../agent/chat-service.js";
import type { AgentEvent } from "../agents/agent-events.js";
import { approvePairingCode, listPendingPairings } from "../channels/pairing.js";
import {
  ensureStateDir,
  readConfig,
  resolveRoutingTarget,
  type RoutingTarget,
  type T560Config,
  writeConfig,
} from "../config/state.js";
import { isHeartbeatCheckMessage } from "../gateway/heartbeat.js";
import { startGatewayRuntime } from "../gateway/runtime.js";
import { handleSecureSetupFlow } from "../security/setup-flow.js";
import { ChatLog } from "./components/chat-log.js";
import { CustomEditor } from "./components/custom-editor.js";
import { editorTheme, theme } from "./theme.js";

export type TuiOptions = {
  url?: string;
  token?: string;
  password?: string;
  session?: string;
  deliver?: boolean;
  thinking?: string;
  timeoutMs?: number;
  historyLimit?: number;
  message?: string;
};

type PairingCommand =
  | { action: "approve"; channel: string; code: string }
  | { action: "list"; channel: string };

type TraceMode = "none" | "compact" | "full";

function createTerminalSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `terminal:${ts}-${rand}`;
}

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

function parseTraceMode(raw: string): TraceMode | null {
  const value = raw.trim().toLowerCase();
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

function composeAssistantText(reply: ChatResponse): string {
  const parts: string[] = [];
  if (reply.thinking && reply.thinking.trim()) {
    parts.push(`[thinking]\n${reply.thinking.trim()}`);
  }
  const message = reply.message?.trim() || "(no output)";
  parts.push(message);
  return parts.join("\n\n");
}

function renderHelpText(): string {
  return [
    "Slash commands:",
    "/help",
    "/clear",
    "/provider [list|<provider/model>|<slot> <provider/model>]",
    "/tools [expand|collapse]",
    "/trace <none|compact|full>",
    "/setup <service-or-site>",
    "/setup mode password|mfa",
    "/setup list",
    "/setup clear <service-or-site>",
    "/setup cancel",
    "/pair <CODE>",
    "/exit",
  ].join("\n");
}

function collectProviderHints(config: T560Config): { providerIds: string[]; providerRefs: string[] } {
  const providerIds = Object.keys(config.providers ?? {}).sort();
  const refs = new Set<string>();
  for (const providerId of providerIds) {
    const models = config.providers?.[providerId]?.models ?? [];
    for (const model of models) {
      const trimmed = String(model ?? "").trim();
      if (trimmed) {
        refs.add(`${providerId}/${trimmed}`);
      }
    }
  }
  for (const slot of ["default", "planning", "coding"] as const) {
    const route = resolveRoutingTarget(config, slot);
    if (route?.provider && route.model) {
      refs.add(`${route.provider}/${route.model}`);
    }
  }
  return {
    providerIds,
    providerRefs: [...refs].sort(),
  };
}

function parseProviderModelRef(raw: string): RoutingTarget | null {
  const value = raw.trim();
  const slash = value.indexOf("/");
  if (slash <= 0 || slash >= value.length - 1) {
    return null;
  }
  const provider = value.slice(0, slash).trim();
  const model = value.slice(slash + 1).trim();
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}

function providerCommandUsage(): string {
  return [
    "Usage:",
    "- /provider list",
    "- /provider <provider>/<model>",
    "- /provider <default|planning|coding> <provider>/<model>",
    "Examples:",
    "- /provider openai-codex/gpt-5.1-codex-mini",
    "- /provider coding openai-codex/gpt-5.1-codex-mini",
  ].join("\n");
}

function getSlashCommands(options?: { providerRefs?: string[]; providerIds?: string[] }): SlashCommand[] {
  const providerRefs = options?.providerRefs ?? [];
  const providerIds = options?.providerIds ?? [];

  return [
    { name: "help", description: "Show command help" },
    { name: "clear", description: "Clear chat log" },
    {
      name: "provider",
      description: "Switch provider/model route",
      getArgumentCompletions: (prefix) => {
        const raw = prefix.trim().toLowerCase();
        if (!raw) {
          return [
            { value: "list", label: "list" },
            ...providerRefs.slice(0, 5).map((value) => ({ value, label: value })),
          ];
        }
        if (raw.startsWith("list")) {
          return [{ value: "list", label: "list" }];
        }
        const slotMatch = /^(default|planning|coding)\s+(.+)?$/i.exec(raw);
        if (slotMatch) {
          const slot = String(slotMatch[1] ?? "default").toLowerCase();
          const tail = String(slotMatch[2] ?? "").trim();
          return providerRefs
            .filter((value) => value.toLowerCase().startsWith(tail))
            .slice(0, 6)
            .map((value) => ({ value: `${slot} ${value}`, label: `${slot} ${value}` }));
        }
        const directMatches = providerRefs
          .filter((value) => value.toLowerCase().startsWith(raw))
          .slice(0, 6)
          .map((value) => ({ value, label: value }));
        if (directMatches.length > 0) {
          return directMatches;
        }
        return providerIds
          .filter((value) => value.toLowerCase().startsWith(raw))
          .slice(0, 6)
          .map((value) => ({ value: `${value}/`, label: `${value}/` }));
      },
    },
    {
      name: "tools",
      description: "Expand or collapse tool output",
      getArgumentCompletions: (prefix) =>
        ["expand", "collapse", "toggle"]
          .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
          .map((value) => ({ value, label: value })),
    },
    {
      name: "trace",
      description: "Set trace verbosity",
      getArgumentCompletions: (prefix) =>
        ["none", "compact", "full"]
          .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
          .map((value) => ({ value, label: value })),
    },
    {
      name: "setup",
      description: "Secure setup for a service/site",
      getArgumentCompletions: (prefix) => {
        const raw = prefix.trim().toLowerCase();
        if (raw.startsWith("clear ")) {
          const tail = raw.slice("clear ".length).trim();
          return ["email", "x.com", "havenvaults2-0"]
            .filter((value) => value.startsWith(tail))
            .map((value) => ({ value: `clear ${value}`, label: `clear ${value}` }));
        }
        if (raw.startsWith("mode ")) {
          const tail = raw.slice("mode ".length).trim();
          return ["password", "mfa"]
            .filter((value) => value.startsWith(tail))
            .map((value) => ({ value: `mode ${value}`, label: `mode ${value}` }));
        }
        return ["email", "x.com", "list", "cancel", "clear", "mode", "havenvaults2-0"]
          .filter((value) => value.startsWith(raw))
          .map((value) => ({ value, label: value }));
      },
    },
    { name: "pair", description: "Approve/list pairing" },
    { name: "exit", description: "Exit TUI" },
    { name: "quit", description: "Exit TUI" },
  ];
}

function getSlashSuggestions(input: string, commands: SlashCommand[]): string[] {
  const line = input.trimStart();
  if (!line.startsWith("/")) {
    return [];
  }

  const withoutSlash = line.slice(1);
  if (!withoutSlash) {
    return commands
      .slice(0, 6)
      .map((command) => `/${command.name}`);
  }

  const rawParts = withoutSlash.split(/\s+/g);
  const commandToken = String(rawParts[0] ?? "").trim().toLowerCase();
  if (!commandToken) {
    return commands
      .slice(0, 6)
      .map((command) => `/${command.name}`);
  }

  const commandMatches = commands.filter((command) => command.name.startsWith(commandToken));
  if (commandMatches.length === 0) {
    return [];
  }

  const hasArgs = /\s/.test(withoutSlash);
  const exact = commands.find((command) => command.name === commandToken);
  if (!hasArgs || !exact || !exact.getArgumentCompletions) {
    return commandMatches
      .slice(0, 6)
      .map((command) => `/${command.name}`);
  }

  const argumentText = withoutSlash.slice(commandToken.length).trimStart();
  const argumentMatches = exact.getArgumentCompletions(argumentText) ?? [];
  if (argumentMatches.length === 0) {
    return [`/${exact.name}`];
  }
  return argumentMatches
    .slice(0, 5)
    .map((item) => `/${exact.name} ${item.value}`.trim());
}

export async function runTui(opts: TuiOptions = {}): Promise<void> {
  await ensureStateDir();
  const gateway = await startGatewayRuntime();
  const sessionId = createTerminalSessionId();
  const externalUserId = "terminal-user";

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const root = new Container();
  const chatLog = new ChatLog();
  const commandMenu = new Text("", 1, 0);
  const editor = new CustomEditor(tui, editorTheme);

  root.addChild(chatLog);
  root.addChild(commandMenu);
  root.addChild(editor);
  tui.addChild(root);
  tui.setFocus(editor);

  let terminalBusy = false;
  let traceMode: TraceMode = "compact";
  let toolsExpanded = false;
  let shuttingDown = false;
  let lastCtrlCAt = 0;

  let slashCommands: SlashCommand[] = [];

  const refreshRoutingUiState = async (): Promise<void> => {
    const config = await readConfig();
    const hints = collectProviderHints(config);
    slashCommands = getSlashCommands({
      providerRefs: hints.providerRefs,
      providerIds: hints.providerIds,
    });
    editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands));
  };

  const updateCommandMenu = (): void => {
    const suggestions = getSlashSuggestions(editor.getText(), slashCommands);
    if (suggestions.length === 0) {
      commandMenu.setText("");
      return;
    }
    const prefix = theme.dim("commands ");
    const separator = theme.dim(" | ");
    const rendered = suggestions
      .map((value, index) => (index === 0 ? theme.accentBright(value) : theme.accent(value)))
      .join(separator);
    commandMenu.setText(`${prefix}${rendered}`);
  };

  const requestRender = (): void => {
    updateCommandMenu();
    tui.requestRender();
  };

  const addSystem = (text: string): void => {
    chatLog.addSystem(text);
    requestRender();
  };

  const stopWaiting = (): void => {
    terminalBusy = false;
    requestRender();
  };

  const startWaiting = (): void => {
    terminalBusy = true;
    requestRender();
  };

  const unsubscribeEvents = gateway.subscribeEvents({
    sessionId,
    onEvent: (event: AgentEvent) => {
      if (event.stream === "tool") {
        const phase = event.data.phase;
        const toolCallId = event.data.toolCallId;
        if (!toolCallId) {
          return;
        }
        if (phase === "start") {
          chatLog.startTool(toolCallId, event.data.name || "tool", event.data.args);
        } else if (phase === "update") {
          if (traceMode === "full") {
            chatLog.updateToolResult(toolCallId, event.data.partialResult, { partial: true });
          }
        } else if (phase === "end") {
          chatLog.updateToolResult(toolCallId, event.data.result, { isError: false });
        } else if (phase === "error") {
          chatLog.updateToolResult(
            toolCallId,
            event.data.result ?? {
              content: [{ type: "text", text: event.data.error ?? "tool error" }],
            },
            { isError: true },
          );
        }
        requestRender();
        return;
      }

      if (event.stream === "assistant") {
        if (traceMode === "none") {
          return;
        }
        const text = event.data.text.trim();
        if (!text) {
          return;
        }
        const prefix = event.data.phase === "pretool" ? "🧠" : "↳";
        addSystem(`${prefix} ${text}`);
        return;
      }

      if (event.stream === "status") {
        if (traceMode === "none") {
          return;
        }
        if (event.data.phase === "route") {
          const slot = event.data.slot ?? "default";
          const route = `${event.data.provider ?? "?"}/${event.data.model ?? "?"}`;
          addSystem(`route ${slot} -> ${route}`);
        }
      }
    },
  });

  const handlePairing = async (pairingCommand: PairingCommand): Promise<void> => {
    if (pairingCommand.action === "list") {
      const pending = await listPendingPairings({ channel: pairingCommand.channel });
      if (pending.length === 0) {
        addSystem(`No pending ${pairingCommand.channel} pairing requests.`);
        return;
      }
      addSystem(`Pending ${pairingCommand.channel} pairing requests:`);
      for (const entry of pending) {
        addSystem(`- code=${entry.code} user=${entry.userId} chat=${entry.chatId}`);
      }
      return;
    }

    const approved = await approvePairingCode({
      channel: pairingCommand.channel,
      code: pairingCommand.code,
    });
    if (!approved) {
      addSystem(`No pending ${pairingCommand.channel} request for code ${pairingCommand.code}.`);
      addSystem(`Try: t560 pairing list ${pairingCommand.channel}`);
      return;
    }
    addSystem(`Approved ${pairingCommand.channel} code ${approved.code}.`);
    addSystem(`user=${approved.userId} chat=${approved.chatId}`);
  };

  let resolveExit: (() => void) | null = null;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    stopWaiting();
    unsubscribeEvents();
    addSystem(`shutting down t560 (${reason})`);
    tui.stop();
    await gateway.close();
    resolveExit?.();
  };

  editor.onCtrlC = () => {
    const now = Date.now();
    if (now - lastCtrlCAt < 800) {
      void shutdown("SIGINT");
      return;
    }
    lastCtrlCAt = now;
    addSystem("Press Ctrl+C again to exit.");
  };
  editor.onCtrlD = () => {
    void shutdown("EOF");
  };
  editor.onCtrlL = () => {
    chatLog.clearAll();
    requestRender();
  };
  editor.onCtrlT = () => {
    traceMode = traceMode === "none" ? "compact" : traceMode === "compact" ? "full" : "none";
    addSystem(`trace set to ${traceMode}`);
    requestRender();
  };
  editor.onChange = () => {
    requestRender();
  };

  editor.onSubmit = (raw: string) => {
    void (async () => {
      const message = raw.trim();
      editor.setText("");

      if (!message) {
        requestRender();
        return;
      }
      if (isHeartbeatCheckMessage(message)) {
        requestRender();
        return;
      }

      if (message === "/exit" || message === "/quit") {
        await shutdown("user request");
        return;
      }
      if (message === "/help" || message === "/commands") {
        addSystem(renderHelpText());
        return;
      }
      if (message === "/clear") {
        chatLog.clearAll();
        requestRender();
        return;
      }
      if (message.startsWith("/provider")) {
        const match = /^\/provider(?:\s+(.+))?$/i.exec(message);
        const args = String(match?.[1] ?? "").trim();
        const config = await readConfig();
        const currentDefault = resolveRoutingTarget(config, "default");
        const currentPlanning = resolveRoutingTarget(config, "planning");
        const currentCoding = resolveRoutingTarget(config, "coding");
        const hints = collectProviderHints(config);

        if (!args) {
          const providersText =
            hints.providerIds.length > 0 ? hints.providerIds.join(", ") : "(none configured)";
          addSystem(
            [
              `Current routes:`,
              `- default: ${currentDefault?.provider && currentDefault?.model ? `${currentDefault.provider}/${currentDefault.model}` : "not-configured"}`,
              `- planning: ${currentPlanning?.provider && currentPlanning?.model ? `${currentPlanning.provider}/${currentPlanning.model}` : "not-configured"}`,
              `- coding: ${currentCoding?.provider && currentCoding?.model ? `${currentCoding.provider}/${currentCoding.model}` : "not-configured"}`,
              `Configured providers: ${providersText}`,
              providerCommandUsage(),
            ].join("\n"),
          );
          return;
        }

        if (args.toLowerCase() === "list") {
          const refs =
            hints.providerRefs.length > 0
              ? hints.providerRefs.slice(0, 30).map((value) => `- ${value}`).join("\n")
              : "(no model hints in config; use /provider <provider>/<model>)";
          addSystem([`Available provider/model refs:`, refs].join("\n"));
          return;
        }

        const slotMatch = /^(default|planning|coding)\s+(.+)$/i.exec(args);
        const slot = slotMatch ? (slotMatch[1].toLowerCase() as "default" | "planning" | "coding") : null;
        const refInput = slotMatch ? String(slotMatch[2] ?? "").trim() : args;
        const parsedRef = parseProviderModelRef(refInput);
        if (!parsedRef?.provider || !parsedRef.model) {
          addSystem(providerCommandUsage());
          return;
        }
        if (hints.providerIds.length > 0 && !hints.providerIds.includes(parsedRef.provider)) {
          addSystem(
            `Unknown provider '${parsedRef.provider}'. Use one of: ${hints.providerIds.join(", ")}.`,
          );
          return;
        }

        const nextRouting = { ...(config.routing ?? {}) };
        if (slot) {
          nextRouting[slot] = parsedRef;
        } else {
          nextRouting.default = parsedRef;
          nextRouting.planning = parsedRef;
          nextRouting.coding = parsedRef;
        }
        await writeConfig({
          ...config,
          provider: parsedRef.provider,
          routing: nextRouting,
        });
        await refreshRoutingUiState();
        requestRender();
        addSystem(
          slot
            ? `Updated ${slot} route to ${parsedRef.provider}/${parsedRef.model}.`
            : `Updated default/planning/coding routes to ${parsedRef.provider}/${parsedRef.model}.`,
        );
        return;
      }

      if (message.startsWith("/trace")) {
        const traceMatch = /^\/trace(?:\s+([a-z]+))?$/i.exec(message);
        if (!traceMatch) {
          addSystem("Usage: /trace <none|compact|full>");
          return;
        }
        if (!traceMatch[1]) {
          addSystem(`trace is ${traceMode}`);
          return;
        }
        const next = parseTraceMode(traceMatch[1]);
        if (!next) {
          addSystem("Usage: /trace <none|compact|full>");
          return;
        }
        traceMode = next;
        addSystem(`trace set to ${traceMode}`);
        requestRender();
        return;
      }

      if (message.startsWith("/tools")) {
        const mode = message.split(/\s+/)[1]?.toLowerCase() ?? "";
        if (!mode || mode === "toggle") {
          toolsExpanded = !toolsExpanded;
        } else if (mode === "expand" || mode === "expanded") {
          toolsExpanded = true;
        } else if (mode === "collapse" || mode === "collapsed") {
          toolsExpanded = false;
        } else {
          addSystem("Usage: /tools [expand|collapse]");
          return;
        }
        chatLog.setToolsExpanded(toolsExpanded);
        addSystem(`tool output ${toolsExpanded ? "expanded" : "collapsed"}`);
        requestRender();
        return;
      }

      const setupHandled = await handleSecureSetupFlow({
        sessionId,
        message: raw,
      });
      if (setupHandled.handled) {
        addSystem(setupHandled.message);
        return;
      }

      const pairingCommand = parsePairingCommand(message);
      if (pairingCommand) {
        try {
          await handlePairing(pairingCommand);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          addSystem(`pairing error: ${msg}`);
        }
        return;
      }

      if (terminalBusy) {
        addSystem("waiting for previous response...");
        return;
      }

      chatLog.addUser(message);
      startWaiting();

      try {
        const reply = await gateway.handleMessage({
          channel: "terminal",
          message,
          sessionId,
          externalUserId,
          receivedAt: Date.now(),
        });
        chatLog.finalizeAssistant(composeAssistantText(reply));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        addSystem(`error: ${msg}`);
      } finally {
        stopWaiting();
      }
    })();
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await refreshRoutingUiState().catch(() => {
    slashCommands = getSlashCommands();
  });
  if (slashCommands.length === 0) {
    slashCommands = getSlashCommands();
  }
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands));
  const accessUrl = gateway.dashboard.tailscaleUrl || gateway.dashboard.localUrl;
  addSystem(`server ${accessUrl}`);
  addSystem(`telegram ${gateway.telegram.info}`);
  if (opts.message?.trim()) {
    editor.setText(opts.message.trim());
  }

  tui.start();
  requestRender();
  await exitPromise;
}
