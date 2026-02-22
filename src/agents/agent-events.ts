import { EventEmitter } from "node:events";

export type AgentEvent =
  | {
      stream: "tool";
      sessionId: string;
      channel: string;
      timestamp: number;
      data: {
        phase: "start" | "update" | "end" | "error";
        toolCallId: string;
        name: string;
        args?: Record<string, unknown>;
        partialResult?: unknown;
        result?: unknown;
        error?: string;
      };
    }
  | {
      stream: "assistant";
      sessionId: string;
      channel: string;
      timestamp: number;
      data: {
        phase: "pretool" | "progress";
        text: string;
      };
    }
  | {
      stream: "status";
      sessionId: string;
      channel: string;
      timestamp: number;
      data: {
        phase: "route" | "provider";
        slot?: "default" | "planning" | "coding";
        provider?: string;
        model?: string;
      };
    };

const emitter = new EventEmitter();
emitter.setMaxListeners(1000);

const EVENT_NAME = "agent:event";

export function emitAgentEvent(event: AgentEvent): void {
  emitter.emit(EVENT_NAME, event);
}

export function subscribeAgentEvents(
  listener: (event: AgentEvent) => void,
  filter?: { sessionId?: string }
): () => void {
  const wrapped = (event: AgentEvent) => {
    if (filter?.sessionId && event.sessionId !== filter.sessionId) {
      return;
    }
    listener(event);
  };

  emitter.on(EVENT_NAME, wrapped);
  return () => {
    emitter.off(EVENT_NAME, wrapped);
  };
}
