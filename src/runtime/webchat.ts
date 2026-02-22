import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

export type ChatEnvelope = {
  type: "message";
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: string;
};

export type WebChatServer = {
  port: number;
  url: string;
  broadcast: (message: ChatEnvelope) => void;
  close: () => Promise<void>;
};

const WEBCHAT_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>T560 WebChat</title>
  <style>
    :root {
      --bg: #0a0f1e;
      --panel: #101933;
      --text: #ecf2ff;
      --muted: #98a3bf;
      --accent: #15d1b5;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Space Grotesk", "Segoe UI", sans-serif;
      background: radial-gradient(circle at 20% 20%, #0f234b 0%, var(--bg) 55%);
      color: var(--text);
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 20px;
    }
    .app {
      width: min(900px, 100%);
      background: rgba(16, 25, 51, 0.92);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 16px;
      overflow: hidden;
      backdrop-filter: blur(6px);
    }
    .head {
      padding: 14px 16px;
      border-bottom: 1px solid rgba(255,255,255,0.12);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 14px;
    }
    .status { color: var(--muted); }
    .chat {
      height: 62vh;
      overflow: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .msg { padding: 10px 12px; border-radius: 10px; line-height: 1.45; white-space: pre-wrap; }
    .user { align-self: flex-end; background: #17395f; }
    .assistant { align-self: flex-start; background: #21322b; border: 1px solid rgba(21,209,181,0.25); }
    .system { align-self: center; color: var(--muted); background: transparent; border: 1px dashed rgba(255,255,255,0.2); }
    form { display: flex; gap: 8px; padding: 12px; border-top: 1px solid rgba(255,255,255,0.12); }
    input {
      flex: 1; border-radius: 10px; border: 1px solid rgba(255,255,255,0.2);
      background: #0f1831; color: var(--text); padding: 12px;
    }
    button {
      border: 0; border-radius: 10px; background: var(--accent);
      color: #04231e; font-weight: 700; padding: 0 16px; cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="app">
    <div class="head">
      <strong>T560 WebChat</strong>
      <span class="status" id="status">connecting...</span>
    </div>
    <div id="chat" class="chat"></div>
    <form id="form">
      <input id="input" autocomplete="off" placeholder="Send a message to T560..." />
      <button type="submit">Send</button>
    </form>
  </div>
  <script>
    const chat = document.getElementById("chat");
    const status = document.getElementById("status");
    const input = document.getElementById("input");
    const form = document.getElementById("form");

    function append(role, text) {
      const el = document.createElement("div");
      el.className = "msg " + role;
      el.textContent = text;
      chat.appendChild(el);
      chat.scrollTop = chat.scrollHeight;
    }

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(protocol + "//" + location.host + "/ws");
    ws.addEventListener("open", () => status.textContent = "connected");
    ws.addEventListener("close", () => status.textContent = "disconnected");
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "message") append(msg.role, msg.text);
      } catch {}
    });

    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      ws.send(JSON.stringify({ type: "user_message", text }));
      input.value = "";
    });
  </script>
</body>
</html>`;

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export async function startWebChatServer(params: {
  port: number;
  onUserMessage: (text: string) => void | Promise<void>;
}): Promise<WebChatServer> {
  const clients = new Set<WebSocket>();

  const server = http.createServer((req, res) => {
    if (!req.url || req.url === "/" || req.url.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(WEBCHAT_HTML);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    send(ws, {
      type: "message",
      role: "system",
      text: "WebChat connected.",
      timestamp: new Date().toISOString(),
    } satisfies ChatEnvelope);

    ws.on("message", async (chunk) => {
      try {
        const parsed = JSON.parse(String(chunk)) as { type?: string; text?: string };
        if (parsed.type === "user_message" && typeof parsed.text === "string") {
          await params.onUserMessage(parsed.text);
        }
      } catch {
        send(ws, {
          type: "message",
          role: "system",
          text: "Invalid message payload.",
          timestamp: new Date().toISOString(),
        } satisfies ChatEnvelope);
      }
    });
    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params.port, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : params.port;
  const url = `http://127.0.0.1:${actualPort}`;

  return {
    port: actualPort,
    url,
    broadcast(message) {
      for (const ws of clients) {
        send(ws, message);
      }
    },
    async close() {
      for (const ws of clients) {
        ws.close();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

