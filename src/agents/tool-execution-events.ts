import { emitAgentEvent } from "./agent-events.js";
import { progressMessageForToolStart } from "./tool-progress.js";

const EMIT_SYNTHETIC_PROGRESS = process.env.T560_SYNTH_PROGRESS !== "0";

export function handleToolExecutionStart(params: {
  sessionId: string;
  channel: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}): void {
  emitAgentEvent({
    stream: "tool",
    sessionId: params.sessionId,
    channel: params.channel,
    timestamp: Date.now(),
    data: {
      phase: "start",
      toolCallId: params.toolCallId,
      name: params.toolName,
      args: params.args
    }
  });

  const progress = progressMessageForToolStart({
    toolName: params.toolName,
    args: params.args
  });
  if (EMIT_SYNTHETIC_PROGRESS && progress) {
    emitAgentEvent({
      stream: "assistant",
      sessionId: params.sessionId,
      channel: params.channel,
      timestamp: Date.now(),
      data: {
        phase: "progress",
        text: progress
      }
    });
  }
}

export function handleToolExecutionUpdate(params: {
  sessionId: string;
  channel: string;
  toolCallId: string;
  toolName: string;
  partialResult: unknown;
}): void {
  emitAgentEvent({
    stream: "tool",
    sessionId: params.sessionId,
    channel: params.channel,
    timestamp: Date.now(),
    data: {
      phase: "update",
      toolCallId: params.toolCallId,
      name: params.toolName,
      partialResult: params.partialResult
    }
  });
}

export function handleToolExecutionEnd(params: {
  sessionId: string;
  channel: string;
  toolCallId: string;
  toolName: string;
  result: unknown;
  error?: string;
}): void {
  emitAgentEvent({
    stream: "tool",
    sessionId: params.sessionId,
    channel: params.channel,
    timestamp: Date.now(),
    data: {
      phase: params.error ? "error" : "end",
      toolCallId: params.toolCallId,
      name: params.toolName,
      result: params.result,
      error: params.error
    }
  });
}
