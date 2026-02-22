import test from "node:test";
import assert from "node:assert/strict";

import { executeToolCall } from "../src/agents/pi-tool-definition-adapter.ts";
import { formatTerminalToolEvent } from "../src/format/message-formatter.ts";

test("executeToolCall emits start/update/end hooks and forwards onUpdate payloads", async () => {
  const events = [];
  const tools = [
    {
      name: "mock_tool",
      description: "mock",
      parameters: {},
      execute: async (_toolCallId, _params, _signal, onUpdate) => {
        onUpdate?.({ stream: "stdout", chunk: "step 1" });
        return {
          ok: true,
          value: 42,
        };
      },
    },
  ];

  const out = await executeToolCall({
    tools,
    toolDefinitions: [],
    toolCall: {
      id: "call-1",
      name: "mock_tool",
      arguments: {
        message: "hello",
      },
    },
    eventHooks: {
      onStart: (evt) => events.push({ type: "start", ...evt }),
      onUpdate: (evt) => events.push({ type: "update", ...evt }),
      onEnd: (evt) => events.push({ type: "end", ...evt }),
    },
  });

  assert.equal(out.isError, false);
  assert.equal(events.length, 3);
  assert.equal(events[0].type, "start");
  assert.equal(events[1].type, "update");
  assert.equal(events[2].type, "end");
  assert.equal(events[1].partialResult.stream, "stdout");
  assert.equal(events[2].isError, false);
});

test("formatTerminalToolEvent renders assistant and status stream progress", () => {
  const assistantLine = formatTerminalToolEvent({
    stream: "assistant",
    sessionId: "s1",
    channel: "terminal",
    timestamp: Date.now(),
    data: {
      phase: "progress",
      text: "Searching the web for latest standings.",
    },
  });
  assert.match(String(assistantLine), /Searching the web/i);

  const routeLine = formatTerminalToolEvent({
    stream: "status",
    sessionId: "s1",
    channel: "terminal",
    timestamp: Date.now(),
    data: {
      phase: "route",
      slot: "default",
      provider: "openai-codex",
      model: "gpt-5.1-codex-mini",
    },
  });
  assert.match(String(routeLine), /route:/i);
  assert.match(String(routeLine), /openai-codex/i);
});
