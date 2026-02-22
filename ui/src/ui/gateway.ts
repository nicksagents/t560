/**
 * WebSocket gateway client — simplified version of OpenClaw's protocol.
 * Frame types: req (client→server), res (server→client), event (server→client)
 */
import { uuid } from "./uuid.js";

export interface GatewayFrame {
  type: "req" | "res" | "event";
  id?: string;
  method?: string;
  params?: unknown;
  ok?: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
  event?: string;
  seq?: number;
}

export interface GatewayClientOptions {
  url: string;
  onHello: (payload: any) => void;
  onEvent: (event: string, payload: any, seq?: number) => void;
  onClose: (code: number, reason: string) => void;
  onError: (error: string) => void;
}

type PendingRequest = {
  resolve: (payload: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class GatewayBrowserClient {
  private ws: WebSocket | null = null;
  private opts: GatewayClientOptions;
  private pending = new Map<string, PendingRequest>();
  private reconnectDelay = 800;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private lastSeq = 0;

  // Reconnect constants
  private static readonly RECONNECT_MIN = 800;
  private static readonly RECONNECT_MAX = 15000;
  private static readonly RECONNECT_FACTOR = 1.7;
  private static readonly REQUEST_TIMEOUT = 30000;

  constructor(opts: GatewayClientOptions) {
    this.opts = opts;
  }

  connect(): void {
    this.intentionallyClosed = false;
    this.doConnect();
  }

  private doConnect(): void {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = GatewayBrowserClient.RECONNECT_MIN;
      console.log("[gateway] WebSocket connected, sending handshake…");
      // Send connect handshake
      this.request("connect", {
        client: { id: "t560-ui", version: "0.1.0" },
      }).then((payload) => {
        console.log("[gateway] Handshake OK");
        this.opts.onHello(payload);
      }).catch((err) => {
        console.error("[gateway] Handshake failed:", err);
        this.opts.onError(`Connect handshake failed: ${err.message}`);
      });
    };

    ws.onmessage = (ev) => {
      try {
        const frame: GatewayFrame = JSON.parse(ev.data as string);
        this.handleFrame(frame);
      } catch {
        // ignore malformed frames
      }
    };

    ws.onclose = (ev) => {
      console.log(`[gateway] WebSocket closed: code=${ev.code} reason=${ev.reason || "(none)"}`);
      this.ws = null;
      this.rejectAllPending("Connection closed");
      this.opts.onClose(ev.code, ev.reason);

      if (!this.intentionallyClosed) {
        console.log(`[gateway] Reconnecting in ${this.reconnectDelay}ms…`);
        this.scheduleReconnect();
      }
    };

    ws.onerror = (ev) => {
      console.error("[gateway] WebSocket error:", ev);
    };
  }

  private handleFrame(frame: GatewayFrame): void {
    if (frame.type === "res" && frame.id) {
      const pending = this.pending.get(frame.id);
      if (pending) {
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.ok) {
          pending.resolve(frame.payload);
        } else {
          pending.reject(
            new Error(frame.error?.message ?? "Request failed")
          );
        }
      }
    } else if (frame.type === "event" && frame.event) {
      // Track sequence for gap detection
      if (frame.seq !== undefined) {
        this.lastSeq = frame.seq;
      }
      this.opts.onEvent(frame.event, frame.payload, frame.seq);
    }
  }

  /** Send a request and wait for response */
  request(method: string, params?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }

      const id = uuid();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Request timeout"));
      }, GatewayBrowserClient.REQUEST_TIMEOUT);

      this.pending.set(id, { resolve, reject, timer });

      const frame: GatewayFrame = { type: "req", id, method, params };
      this.ws.send(JSON.stringify(frame));
    });
  }

  /** Send a fire-and-forget request (no response expected) */
  send(method: string, params?: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const frame: GatewayFrame = {
      type: "req",
      id: uuid(),
      method,
      params,
    };
    this.ws.send(JSON.stringify(frame));
  }

  close(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(1000, "Client closing"); } catch {}
      this.ws = null;
    }
    this.rejectAllPending("Client closed");
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(
      this.reconnectDelay * GatewayBrowserClient.RECONNECT_FACTOR,
      GatewayBrowserClient.RECONNECT_MAX
    );
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
