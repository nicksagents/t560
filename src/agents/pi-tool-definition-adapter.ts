import type { Tool, ToolCall } from "@mariozechner/pi-ai";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { normalizeToolName } from "./tool-policy.js";
import { applyToolResultContract } from "./tool-result-contract.js";

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
  eventHooks?: {
    onStart?: (params: { toolCallId: string; toolName: string; args: Record<string, unknown> }) => void;
    onUpdate?: (params: { toolCallId: string; toolName: string; partialResult: unknown }) => void;
    onEnd?: (params: {
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
      error?: string;
    }) => void;
  };
};

export type ExecuteToolCallResult = {
  isError: boolean;
  content: string;
};

const BROWSER_RESULT_MAX_TEXT_CHARS = 3_500;
const BROWSER_RESULT_MAX_LINKS = 40;
const BROWSER_RESULT_MAX_REFS = 60;
const BROWSER_RESULT_MAX_FORMS = 24;
const BROWSER_RESULT_MAX_FORM_FIELDS = 40;

function truncateText(value: unknown, maxChars: number): string {
  const text = String(value ?? "");
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n[truncated for tool context]`;
}

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

  if (normalizedName === "browser") {
    const actionRaw = String(record.action ?? "").trim().toLowerCase();
    if (actionRaw === "go") {
      record.action = "navigate";
    } else if (actionRaw === "goto" || actionRaw === "visit") {
      record.action = "open";
    }
  }

  return record;
}

function compactBrowserToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }
  const source = result as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };

  const compactSnapshot = (snapshotValue: unknown): Record<string, unknown> | unknown => {
    if (!snapshotValue || typeof snapshotValue !== "object") {
      return snapshotValue;
    }
    const snapshot = snapshotValue as Record<string, unknown>;
    const compactLink = (entry: unknown): unknown => {
      if (!entry || typeof entry !== "object") {
        return entry;
      }
      const link = entry as Record<string, unknown>;
      return {
        ...(typeof link.index === "number" ? { index: link.index } : {}),
        ...(typeof link.text === "string" ? { text: truncateText(link.text, 160) } : {}),
        ...(typeof link.url === "string" ? { url: truncateText(link.url, 240) } : {}),
      };
    };
    const compactRef = (entry: unknown): unknown => {
      if (!entry || typeof entry !== "object") {
        return entry;
      }
      const ref = entry as Record<string, unknown>;
      return {
        ...(typeof ref.ref === "string" ? { ref: ref.ref } : {}),
        ...(typeof ref.kind === "string" ? { kind: ref.kind } : {}),
        ...(typeof ref.role === "string" ? { role: ref.role } : {}),
        ...(typeof ref.name === "string" ? { name: truncateText(ref.name, 180) } : {}),
        ...(typeof ref.url === "string" ? { url: truncateText(ref.url, 240) } : {}),
        ...(typeof ref.formIndex === "number" ? { formIndex: ref.formIndex } : {}),
        ...(typeof ref.fieldName === "string" ? { fieldName: truncateText(ref.fieldName, 120) } : {}),
        ...(typeof ref.method === "string" ? { method: ref.method } : {}),
        ...(typeof ref.selector === "string" ? { selector: truncateText(ref.selector, 240) } : {}),
      };
    };

    return {
      ...snapshot,
      ...(typeof snapshot.text === "string"
        ? { text: truncateText(snapshot.text, BROWSER_RESULT_MAX_TEXT_CHARS) }
        : {}),
      ...(Array.isArray(snapshot.links)
        ? { links: snapshot.links.slice(0, BROWSER_RESULT_MAX_LINKS).map((entry) => compactLink(entry)) }
        : {}),
      ...(Array.isArray(snapshot.refs)
        ? { refs: snapshot.refs.slice(0, BROWSER_RESULT_MAX_REFS).map((entry) => compactRef(entry)) }
        : {}),
    };
  };

  if ("snapshot" in out) {
    out.snapshot = compactSnapshot(out.snapshot);
  }
  if ("openedSnapshot" in out) {
    out.openedSnapshot = compactSnapshot(out.openedSnapshot);
  }
  if (Array.isArray(out.refs)) {
    out.refs = out.refs.slice(0, BROWSER_RESULT_MAX_REFS).map((entry) => {
      if (!entry || typeof entry !== "object") {
        return entry;
      }
      const ref = entry as Record<string, unknown>;
      return {
        ...(typeof ref.ref === "string" ? { ref: ref.ref } : {}),
        ...(typeof ref.kind === "string" ? { kind: ref.kind } : {}),
        ...(typeof ref.role === "string" ? { role: ref.role } : {}),
        ...(typeof ref.name === "string" ? { name: truncateText(ref.name, 180) } : {}),
        ...(typeof ref.url === "string" ? { url: truncateText(ref.url, 240) } : {}),
        ...(typeof ref.selector === "string" ? { selector: truncateText(ref.selector, 240) } : {}),
      };
    });
  }
  if (Array.isArray(out.forms)) {
    out.forms = out.forms.slice(0, BROWSER_RESULT_MAX_FORMS).map((entry) => {
      if (!entry || typeof entry !== "object") {
        return entry;
      }
      const form = entry as Record<string, unknown>;
      if (!Array.isArray(form.fields)) {
        return form;
      }
      return {
        ...form,
        fields: form.fields.slice(0, BROWSER_RESULT_MAX_FORM_FIELDS),
      };
    });
  }

  return out;
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
  params.eventHooks?.onStart?.({
    toolCallId: params.toolCall.id,
    toolName: normalizedCallName,
    args: normalizedArgs,
  });

  try {
    const rawResult = await tool.execute(
      params.toolCall.id,
      normalizedArgs,
      undefined,
      (partialResult) => {
        params.eventHooks?.onUpdate?.({
          toolCallId: params.toolCall.id,
          toolName: normalizedCallName,
          partialResult,
        });
      },
    );
    const contractShaped = applyToolResultContract(normalizedCallName, rawResult);
    const result =
      normalizedCallName === "browser"
        ? compactBrowserToolResult(contractShaped)
        : contractShaped;
    params.eventHooks?.onEnd?.({
      toolCallId: params.toolCall.id,
      toolName: normalizedCallName,
      result,
      isError: false,
    });
    return {
      isError: false,
      content: stringifyToolResult(result),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    params.eventHooks?.onEnd?.({
      toolCallId: params.toolCall.id,
      toolName: normalizedCallName,
      result: message,
      isError: true,
      error: message,
    });
    return {
      isError: true,
      content: message,
    };
  }
}
