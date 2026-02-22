import type { TSchema } from "@mariozechner/pi-ai";

export type AgentToolUpdateCallback = (partial: unknown) => void;

export type AnyAgentTool = {
  name: string;
  description: string;
  parameters: TSchema;
  ownerOnly?: boolean;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback
  ) => Promise<unknown>;
};

export type ToolPolicyLike = {
  allow?: string[];
  deny?: string[];
};
