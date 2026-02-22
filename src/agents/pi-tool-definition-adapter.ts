import type { Tool, ToolCall } from "@mariozechner/pi-ai";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { normalizeToolName } from "./tool-policy.js";

export type ToolExecutionContext = {
  sessionId?: string;
  channel?: string;
  provider?: string;
  model?: string;
};

export type ExecuteToolCallParams = {
  tools: AnyAgentTool[];
  toolDefinitions: Tool[];
  toolCall: ToolCall;
  context?: ToolExecutionContext;
};

export type ExecuteToolCallResult = {
  isError: boolean;
  content: string;
};

function normalizeToolArgs(toolName: string, args: unknown): Record<string, unknown> {
  if (args === null || args === undefined) {
    return {};
  }

  const normalizedName = normalizeToolName(toolName);

  if (typeof args === "string") {
    if (normalizedName === "exec") {
      return { command: args };
    }
    if (normalizedName === "process") {
      return { action: args };
    }
    return { input: args };
  }

  if (!args || typeof args !== "object") {
    return {};
  }

  const record = { ...(args as Record<string, unknown>) };

  if ("file_path" in record && !("path" in record)) {
    record.path = record.file_path;
    delete record.file_path;
  }

  if ("old_string" in record && !("oldText" in record)) {
    record.oldText = record.old_string;
    delete record.old_string;
  }

  if ("new_string" in record && !("newText" in record)) {
    record.newText = record.new_string;
    delete record.new_string;
  }

  if (normalizedName === "exec") {
    if (record.command === undefined) {
      const fallback =
        record.cmd ??
        record.bash ??
        record.shell ??
        record.script ??
        record.run ??
        record.input;
      if (typeof fallback === "string") {
        record.command = fallback;
      }
    }
    if (record.workdir === undefined && record.cwd === undefined) {
      const dir = record.dir ?? record.directory ?? record.path;
      if (typeof dir === "string") {
        record.workdir = dir;
      }
    }
  }

  if (normalizedName === "process") {
    if (record.action === undefined) {
      const fallback = record.op ?? record.operation ?? record.command;
      if (typeof fallback === "string") {
        record.action = fallback;
      }
    }
  }

  return record;
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (result === null || result === undefined) {
    return "";
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export function toToolDefinitions(tools: AnyAgentTool[]): Tool[] {
  return tools.map((tool) => ({
    name: normalizeToolName(tool.name || "tool"),
    description: tool.description || "",
    parameters: tool.parameters,
  }));
}

export async function executeToolCall(params: ExecuteToolCallParams): Promise<ExecuteToolCallResult> {
  const normalizedCallName = normalizeToolName(params.toolCall.name);

  const tool =
    params.tools.find((candidate) => normalizeToolName(candidate.name) === normalizedCallName) ??
    params.tools.find((candidate) => candidate.name === params.toolCall.name);

  if (!tool) {
    return {
      isError: true,
      content: `Tool not found: ${params.toolCall.name}`,
    };
  }

  const normalizedArgs = normalizeToolArgs(tool.name, params.toolCall.arguments);

  try {
    const result = await tool.execute(params.toolCall.id, normalizedArgs);
    return {
      isError: false,
      content: stringifyToolResult(result),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: message,
    };
  }
}
