import { runBeforeToolCallHooks } from "../plugins/hooks.js";
import { getDiagnosticSessionState } from "./diagnostic-session-state.js";
import { normalizeToolName } from "./tool-policy.js";
import {
  detectToolCallLoop,
  recordToolCall,
  type ToolLoopDetectionConfig
} from "./tool-loop-detection.js";

export type HookContext = {
  sessionId: string;
  channel: string;
  provider?: string;
  model?: string;
  loopDetection?: ToolLoopDetectionConfig;
};

export type HookOutcome =
  | { blocked: true; reason: string }
  | { blocked: false; params: Record<string, unknown> };

const LOOP_WARNING_BUCKET_SIZE = 10;
const MAX_LOOP_WARNING_KEYS = 256;

function shouldEmitLoopWarning(
  state: ReturnType<typeof getDiagnosticSessionState>,
  warningKey: string,
  count: number
): boolean {
  if (!state.toolLoopWarningBuckets) {
    state.toolLoopWarningBuckets = new Map();
  }
  const bucket = Math.floor(count / LOOP_WARNING_BUCKET_SIZE);
  const lastBucket = state.toolLoopWarningBuckets.get(warningKey) ?? 0;
  if (bucket <= lastBucket) {
    return false;
  }
  state.toolLoopWarningBuckets.set(warningKey, bucket);
  if (state.toolLoopWarningBuckets.size > MAX_LOOP_WARNING_KEYS) {
    const oldest = state.toolLoopWarningBuckets.keys().next().value;
    if (oldest) {
      state.toolLoopWarningBuckets.delete(oldest);
    }
  }
  return true;
}

export async function runBeforeToolCallHook(params: {
  toolName: string;
  args: Record<string, unknown>;
  context: HookContext;
  toolCallId?: string;
}): Promise<HookOutcome> {
  const normalizedToolName = normalizeToolName(params.toolName);

  if (params.context.sessionId) {
    const state = getDiagnosticSessionState({ sessionId: params.context.sessionId });
    const loopResult = detectToolCallLoop(
      state,
      normalizedToolName,
      params.args,
      params.context.loopDetection
    );

    if (loopResult.stuck) {
      if (loopResult.level === "critical") {
        return {
          blocked: true,
          reason: loopResult.message
        };
      }
      const warningKey = loopResult.warningKey ?? `${loopResult.detector}:${normalizedToolName}`;
      if (shouldEmitLoopWarning(state, warningKey, loopResult.count)) {
        // warn once per bucket
        console.warn(`[t560] tool loop warning: ${loopResult.message}`);
      }
    }

    recordToolCall(
      state,
      normalizedToolName,
      params.args,
      params.toolCallId,
      params.context.loopDetection
    );
  }
  const result = await runBeforeToolCallHooks({
    toolName: normalizedToolName,
    params: params.args,
    sessionId: params.context.sessionId,
    channel: params.context.channel,
    provider: params.context.provider,
    model: params.context.model
  });

  if (result.block) {
    return {
      blocked: true,
      reason: result.reason ?? "Tool call blocked by hook."
    };
  }

  return {
    blocked: false,
    params: (result.params ?? params.args) as Record<string, unknown>
  };
}
