import chalk from "chalk";
import { TUI, ProcessTerminal, Input } from "@mariozechner/pi-tui";
import WebSocket from "ws";

function safeTrim(v) {
  return String(v ?? "").trim();
}

function normalizeHttpBaseUrl(baseUrl) {
  const u = safeTrim(baseUrl);
  if (!u) return "";
  return u.replace(/\/+$/, "");
}

function wsUrlFromHttpBase(httpBase) {
  const u = new URL(httpBase);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  u.search = "";
  return u.toString();
}

function wrapLine(s, width) {
  const text = String(s ?? "");
  if (width <= 5) return [text.slice(0, Math.max(0, width))];
  const out = [];
  let cur = "";
  for (const token of text.split(/\s+/g)) {
    if (!token) continue;
    if ((cur ? cur.length + 1 : 0) + token.length <= width) {
      cur = cur ? `${cur} ${token}` : token;
    } else {
      if (cur) out.push(cur);
      if (token.length <= width) {
        cur = token;
      } else {
        // Hard wrap long tokens.
        for (let i = 0; i < token.length; i += width) out.push(token.slice(i, i + width));
        cur = "";
      }
    }
  }
  if (cur) out.push(cur);
  return out.length > 0 ? out : [""];
}

class ChatTui {
  focused = false;

  constructor(params) {
    const { terminal, onSubmit } = params;
    this.terminal = terminal;
    this.onSubmit = onSubmit;
    this.messages = [];
    this.status = "connecting";
    this.modelHint = "";
    this.session = "main";

    this.input = new Input();
    this.input.onSubmit = (value) => {
      const text = safeTrim(value);
      this.input.setValue("");
      if (!text) return;
      if (typeof this.onSubmit === "function") this.onSubmit(text);
    };
  }

  setStatus(status) {
    this.status = safeTrim(status) || "idle";
  }

  setModelHint(modelRef) {
    this.modelHint = safeTrim(modelRef);
  }

  setSession(sessionId) {
    this.session = safeTrim(sessionId) || "main";
  }

  setMessages(messages) {
    this.messages = Array.isArray(messages) ? messages.slice() : [];
  }

  append(role, content) {
    this.messages.push({ role, content: String(content ?? "") });
    if (this.messages.length > 500) this.messages = this.messages.slice(-500);
  }

  invalidate() {
    this.input.invalidate();
  }

  handleInput(data) {
    this.input.focused = this.focused;
    this.input.handleInput(data);
  }

  render(width) {
    // Ensure the Input emits CURSOR_MARKER when TUI focuses the root component.
    this.input.focused = this.focused;

    const rows = Number(this.terminal?.rows ?? 24);
    const header = this.renderHeader(width);
    const inputLines = this.input.render(width);
    const chatHeight = Math.max(1, rows - header.length - inputLines.length);
    const chatLines = this.renderChat(width, chatHeight);
    return [...header, ...chatLines, ...inputLines];
  }

  renderHeader(width) {
    const left = chalk.bold("t560");
    const mid = this.modelHint ? chalk.dim(this.modelHint) : chalk.dim("no model selected");
    const right = this.status === "connected" ? chalk.green("connected") : chalk.yellow(this.status || "connecting");
    const line = `${left}  ${mid}  ${chalk.dim("session:")} ${chalk.cyan(this.session)}  ${right}`;
    const clipped = line.length > width ? line.slice(0, Math.max(0, width - 1)) : line;
    return [clipped];
  }

  renderChat(width, height) {
    const inner = Math.max(10, width);
    const lines = [];
    for (const m of this.messages) {
      const role = m.role === "assistant" ? "assistant" : "user";
      const label = role === "assistant" ? chalk.cyan("t560") : chalk.gray("you");
      const prefix = `${label}${chalk.dim(":")} `;
      const wrapW = Math.max(8, inner - prefix.length);
      const chunks = wrapLine(String(m.content ?? ""), wrapW);
      for (let i = 0; i < chunks.length; i += 1) {
        lines.push((i === 0 ? prefix : " ".repeat(prefix.length)) + chunks[i]);
      }
      lines.push(chalk.dim("")); // spacer
    }
    const trimmed = lines.length > height ? lines.slice(-height) : lines;
    // Pad to keep input pinned at bottom.
    const pad = height - trimmed.length;
    if (pad > 0) return [...Array.from({ length: pad }, () => ""), ...trimmed];
    return trimmed;
  }
}

export async function runTui({ url, token, session = "main", modelHint } = {}) {
  const baseUrl = normalizeHttpBaseUrl(url) || "http://127.0.0.1:18789";
  const auth = safeTrim(token);
  if (!auth) throw new Error("Missing gateway token/password.");

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  let ws = null;
  let closed = false;

  const root = new ChatTui({
    terminal,
    onSubmit: (text) => {
      root.append("user", text);
      tui.requestRender();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "user_message", content: text }));
      }
    },
  });
  root.setSession(session);
  root.setModelHint(modelHint);
  root.setStatus("connecting");

  tui.addChild(root);
  tui.start();

  const wsUrl = wsUrlFromHttpBase(baseUrl);
  const wsu = new URL(wsUrl);
  wsu.searchParams.set("token", auth);
  wsu.searchParams.set("session", session);

  ws = new WebSocket(wsu.toString());
  ws.on("open", () => {
    root.setStatus("connected");
    tui.requestRender();
  });
  ws.on("close", () => {
    if (closed) return;
    root.setStatus("disconnected");
    tui.requestRender();
  });
  ws.on("error", () => {
    root.setStatus("error");
    tui.requestRender();
  });
  ws.on("message", (data) => {
    let msg = null;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg?.type === "history" && Array.isArray(msg.messages)) {
      root.setMessages(msg.messages);
      tui.requestRender();
      return;
    }
    if (msg?.type === "message") {
      root.append(msg.role, msg.content);
      tui.requestRender();
      return;
    }
    if (msg?.type === "error") {
      root.append("assistant", `[error] ${String(msg.message ?? "unknown error")}`);
      tui.requestRender();
    }
  });

  const stop = () => {
    if (closed) return;
    closed = true;
    try {
      ws?.close();
    } catch {}
    try {
      tui.stop();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", () => stop());
  process.on("SIGTERM", () => stop());
}

