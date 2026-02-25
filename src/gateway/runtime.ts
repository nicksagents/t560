import type { ChatResponse } from "../agent/chat-service.js";
import { subscribeAgentEvents, type AgentEvent } from "../agents/agent-events.js";
import { readOnboardingStatus, resolveRoutingTarget } from "../config/state.js";
import { startTelegramBridge, type TelegramBridge } from "../channels/telegram.js";
import { startDashboardServer, type DashboardServer } from "../web/dashboard.js";
import { routeGatewayMessage } from "./router.js";
import type { GatewayInboundMessage } from "./types.js";

export type GatewayRuntime = {
  dashboard: DashboardServer;
  telegram: TelegramBridge;
  mode: "foundation" | "provider";
  providerLabel: string;
  onboardingMissing: string[];
  dangerouslyUnrestricted: boolean;
  close: () => Promise<void>;
  handleMessage: (input: GatewayInboundMessage) => Promise<ChatResponse>;
  subscribeEvents: (params: {
    sessionId?: string;
    onEvent: (event: AgentEvent) => void;
  }) => () => void;
};

const DEFAULT_GATEWAY_MESSAGE_TIMEOUT_MS = 15 * 60_000;
const MIN_GATEWAY_MESSAGE_TIMEOUT_MS = 5_000;
const MAX_GATEWAY_MESSAGE_TIMEOUT_MS = 24 * 60 * 60_000;

function resolveGatewayMessageTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const rawSec = Number(env.T560_GATEWAY_MESSAGE_TIMEOUT_SEC ?? "");
  if (Number.isFinite(rawSec) && rawSec > 0) {
    return Math.min(
      MAX_GATEWAY_MESSAGE_TIMEOUT_MS,
      Math.max(MIN_GATEWAY_MESSAGE_TIMEOUT_MS, Math.floor(rawSec * 1000))
    );
  }
  const rawMs = Number(env.T560_GATEWAY_MESSAGE_TIMEOUT_MS ?? "");
  if (Number.isFinite(rawMs) && rawMs > 0) {
    return Math.min(
      MAX_GATEWAY_MESSAGE_TIMEOUT_MS,
      Math.max(MIN_GATEWAY_MESSAGE_TIMEOUT_MS, Math.floor(rawMs))
    );
  }
  return DEFAULT_GATEWAY_MESSAGE_TIMEOUT_MS;
}

function messageLikelyLongRunning(message: string): boolean {
  const text = String(message ?? "").toLowerCase();
  if (!text.trim()) {
    return false;
  }
  return (
    /\blogin\b/.test(text) ||
    /\blog\s*in(?:to)?\b/.test(text) ||
    /\bsign\s*in(?:to)?\b/.test(text) ||
    /\bmfa\b/.test(text) ||
    /\b2fa\b/.test(text) ||
    /\bone[-\s]?time code\b/.test(text) ||
    /\botp\b/.test(text) ||
    /\bdashboard\b/.test(text) ||
    /\bbalance\b/.test(text) ||
    /\baccount\b/.test(text) ||
    /\bportfolio\b/.test(text) ||
    /\bwebsite\b/.test(text) ||
    /\bweb app\b/.test(text)
  );
}

function resolveGatewayTimeoutForMessage(
  message: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const base = resolveGatewayMessageTimeoutMs(env);
  if (!messageLikelyLongRunning(message)) {
    return base;
  }
  return Math.min(MAX_GATEWAY_MESSAGE_TIMEOUT_MS, Math.max(base, 45 * 60_000));
}

async function runWithTimeout<T>(params: {
  operation: Promise<T>;
  timeoutMs: number;
  onTimeout: () => T;
}): Promise<T> {
  const op = params.operation.then(
    (value) => ({ kind: "value" as const, value }),
    (error) => ({ kind: "error" as const, error }),
  );
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "timeout" }), params.timeoutMs);
    timer.unref?.();
  });

  const winner = await Promise.race([op, timeout]);
  if (winner.kind === "value") {
    return winner.value;
  }
  if (winner.kind === "error") {
    throw winner.error;
  }
  return params.onTimeout();
}

export async function startGatewayRuntime(): Promise<GatewayRuntime> {
  const handleMessage = async (input: GatewayInboundMessage): Promise<ChatResponse> => {
    const timeoutMs = resolveGatewayTimeoutForMessage(input.message);
    return await runWithTimeout({
      operation: routeGatewayMessage(input),
      timeoutMs,
      onTimeout: () => ({
        role: "assistant",
        message: `Gateway timeout: request exceeded ${Math.round(timeoutMs / 1000)}s on channel=${input.channel}.`,
        thinking: null,
        toolCalls: [],
        mode: "provider",
        provider: null,
        model: null,
        onboardingRequired: false,
        missing: [],
      }),
    });
  };
  const subscribeEvents = (params: {
    sessionId?: string;
    onEvent: (event: AgentEvent) => void;
  }) =>
    subscribeAgentEvents(params.onEvent, {
      sessionId: params.sessionId
    });

  const dashboard = await startDashboardServer({ handleMessage, subscribeEvents });
  const telegram = await startTelegramBridge({ handleMessage, subscribeEvents });
  const onboarding = await readOnboardingStatus();
  const mode: "foundation" | "provider" = onboarding.onboarded ? "provider" : "foundation";
  const dangerouslyUnrestricted = onboarding.config.tools?.dangerouslyUnrestricted === true;
  const defaultRoute = resolveRoutingTarget(onboarding.config, "default");
  const providerLabel =
    onboarding.onboarded && defaultRoute?.provider && defaultRoute?.model
      ? `${defaultRoute.provider}/${defaultRoute.model}`
      : "not-configured";

  return {
    dashboard,
    telegram,
    mode,
    providerLabel,
    onboardingMissing: onboarding.missing,
    dangerouslyUnrestricted,
    handleMessage,
    subscribeEvents,
    close: async () => {
      await Promise.allSettled([dashboard.close(), telegram.close()]);
    }
  };
}
