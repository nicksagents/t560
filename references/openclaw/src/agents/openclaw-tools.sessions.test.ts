import { describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      session: {
        mainKey: "main",
        scope: "per-sender",
        agentToAgent: { maxPingPongTurns: 2 },
      },
    }),
    resolveGatewayPort: () => 18789,
  };
});

import "./test-helpers/fast-core-tools.js";
import { sleep } from "../utils.js";
import { createOpenClawTools } from "./openclaw-tools.js";

const waitForCalls = async (getCount: () => number, count: number, timeoutMs = 2000) => {
  const start = Date.now();
  while (getCount() < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${count} calls`);
    }
    await sleep(0);
  }
};

describe("sessions tools", () => {
  it("uses number (not integer) in tool schemas for Gemini compatibility", () => {
    const tools = createOpenClawTools();
    const byName = (name: string) => {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      if (!tool) {
        throw new Error(`missing ${name} tool`);
      }
      return tool;
    };

    const schemaProp = (toolName: string, prop: string) => {
      const tool = byName(toolName);
      const schema = tool.parameters as {
        anyOf?: unknown;
        oneOf?: unknown;
        properties?: Record<string, unknown>;
      };
      expect(schema.anyOf).toBeUndefined();
      expect(schema.oneOf).toBeUndefined();

      const properties = schema.properties ?? {};
      const value = properties[prop] as { type?: unknown } | undefined;
      expect(value).toBeDefined();
      if (!value) {
        throw new Error(`missing ${toolName} schema prop: ${prop}`);
      }
      return value;
    };

    expect(schemaProp("sessions_history", "limit").type).toBe("number");
    expect(schemaProp("sessions_list", "limit").type).toBe("number");
    expect(schemaProp("sessions_list", "activeMinutes").type).toBe("number");
    expect(schemaProp("sessions_list", "messageLimit").type).toBe("number");
    expect(schemaProp("sessions_send", "timeoutSeconds").type).toBe("number");
    expect(schemaProp("sessions_spawn", "thinking").type).toBe("string");
    expect(schemaProp("sessions_spawn", "runTimeoutSeconds").type).toBe("number");
    expect(schemaProp("sessions_spawn", "timeoutSeconds").type).toBe("number");
  });

  it("sessions_list filters kinds and includes messages", async () => {
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "main",
              kind: "direct",
              sessionId: "s-main",
              updatedAt: 10,
              lastChannel: "whatsapp",
            },
            {
              key: "discord:group:dev",
              kind: "group",
              sessionId: "s-group",
              updatedAt: 11,
              channel: "discord",
              displayName: "discord:g-dev",
            },
            {
              key: "cron:job-1",
              kind: "direct",
              sessionId: "s-cron",
              updatedAt: 9,
            },
            { key: "global", kind: "global" },
            { key: "unknown", kind: "unknown" },
          ],
        };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            { role: "toolResult", content: [] },
            {
              role: "assistant",
              content: [{ type: "text", text: "hi" }],
            },
          ],
        };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_list");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_list tool");
    }

    const result = await tool.execute("call1", { messageLimit: 1 });
    const details = result.details as {
      sessions?: Array<Record<string, unknown>>;
    };
    expect(details.sessions).toHaveLength(3);
    const main = details.sessions?.find((s) => s.key === "main");
    expect(main?.channel).toBe("whatsapp");
    expect(main?.messages?.length).toBe(1);
    expect(main?.messages?.[0]?.role).toBe("assistant");

    const cronOnly = await tool.execute("call2", { kinds: ["cron"] });
    const cronDetails = cronOnly.details as {
      sessions?: Array<Record<string, unknown>>;
    };
    expect(cronDetails.sessions).toHaveLength(1);
    expect(cronDetails.sessions?.[0]?.kind).toBe("cron");
  });

  it("sessions_history filters tool messages by default", async () => {
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return {
          messages: [
            { role: "toolResult", content: [] },
            { role: "assistant", content: [{ type: "text", text: "ok" }] },
          ],
        };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call3", { sessionKey: "main" });
    const details = result.details as { messages?: unknown[] };
    expect(details.messages).toHaveLength(1);
    expect(details.messages?.[0]?.role).toBe("assistant");

    const withTools = await tool.execute("call4", {
      sessionKey: "main",
      includeTools: true,
    });
    const withToolsDetails = withTools.details as { messages?: unknown[] };
    expect(withToolsDetails.messages).toHaveLength(2);
  });

  it("sessions_history caps oversized payloads and strips heavy fields", async () => {
    callGatewayMock.mockReset();
    const oversized = Array.from({ length: 80 }, (_, idx) => ({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `${String(idx)}:${"x".repeat(5000)}`,
        },
        {
          type: "thinking",
          thinking: "y".repeat(7000),
          thinkingSignature: "sig".repeat(4000),
        },
      ],
      details: {
        giant: "z".repeat(12000),
      },
      usage: {
        input: 1,
        output: 1,
      },
    }));
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return { messages: oversized };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call4b", {
      sessionKey: "main",
      includeTools: true,
    });
    const details = result.details as {
      messages?: Array<Record<string, unknown>>;
      truncated?: boolean;
      droppedMessages?: boolean;
      contentTruncated?: boolean;
      bytes?: number;
    };
    expect(details.truncated).toBe(true);
    expect(details.droppedMessages).toBe(true);
    expect(details.contentTruncated).toBe(true);
    expect(typeof details.bytes).toBe("number");
    expect((details.bytes ?? 0) <= 80 * 1024).toBe(true);
    expect(details.messages && details.messages.length > 0).toBe(true);

    const first = details.messages?.[0] as
      | {
