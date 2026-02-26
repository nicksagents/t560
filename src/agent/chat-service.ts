import type { GatewayChannelId, GatewayInboundMessage } from "../gateway/types.js";
import {
  readOnboardingStatus,
  resolveRoutingTarget,
  type RoutingTarget,
  type T560Config,
} from "../config/state.js";
import { chatWithProvider } from "../provider/run.js";
import { emitAgentEvent } from "../agents/agent-events.js";
import { handleSecureSetupFlow } from "../security/setup-flow.js";

export type ChatResponse = {
  role: "assistant";
  message: string;
  thinking: string | null;
  toolCalls: string[];
  mode: "foundation" | "provider";
  provider: string | null;
  model: string | null;
  onboardingRequired: boolean;
  missing: string[];
};

const DEFAULT_CHAT_TIMEOUT_MS = 15 * 60_000;
const MIN_CHAT_TIMEOUT_MS = 5_000;
const MAX_CHAT_TIMEOUT_MS = 24 * 60 * 60_000;
const DEFAULT_LOCAL_CHAT_TIMEOUT_MS = 30 * 60_000;
const MIN_LOCAL_CHAT_TIMEOUT_MS = 60_000;

function foundationMessage(input: string, source: GatewayChannelId, missing: string[]): string {
  const missingText = missing.join(", ");
  return [
    `Foundation mode (${source}) is active.`,
    `You said: \"${input}\"`,
    `To unlock provider inference, complete onboarding fields: ${missingText}.`
  ].join(" ");
}

type RouteSignal = {
  label: string;
  pattern: RegExp;
  weight: number;
  strong?: boolean;
};

type RouteIntentAnalysis = {
  slot: "default" | "planning" | "coding";
  planningScore: number;
  codingScore: number;
  planningSignals: string[];
  codingSignals: string[];
};

const PLANNING_SIGNALS: RouteSignal[] = [
  {
    label: "architecture",
    pattern: /\b(architecture|design doc|technical design|system design|design proposal)\b/,
    weight: 3,
    strong: true,
  },
  {
    label: "roadmap",
    pattern: /\b(roadmap|migration plan|rollout plan|implementation plan)\b/,
    weight: 3,
    strong: true,
  },
  {
    label: "planning",
    pattern: /\b(plan|strategy)\b.{0,40}\b(feature|project|migration|rollout|approach|implementation|build)\b/,
    weight: 2,
  },
  {
    label: "options",
    pattern: /\b(compare|trade[-\s]?offs?|pros and cons|evaluate options|decision matrix)\b/,
    weight: 2,
  },
  {
    label: "step-plan",
    pattern: /\bstep[-\s]?by[-\s]?step plan\b/,
    weight: 2,
  },
  {
    label: "task-list",
    pattern: /\b(list of tasks|task list|task breakdown|todo list|checklist|milestones?)\b/,
    weight: 3,
    strong: true,
  },
  {
    label: "plan-request",
    pattern: /\b(plan|planning)\b.{0,40}\b(first|before coding|before implementation|next steps?)\b/,
    weight: 3,
    strong: true,
  },
];

const CODING_SIGNALS: RouteSignal[] = [
  {
    label: "fenced-code",
    pattern: /```/,
    weight: 3,
    strong: true,
  },
  {
    label: "repo-path",
    pattern: /\b(src\/|package\.json|tsconfig\.json|dockerfile|makefile|requirements\.txt|pom\.xml)\b/,
    weight: 3,
    strong: true,
  },
  {
    label: "code-file",
    pattern: /\b\w+\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|cs|rb|php|swift|kt)\b/,
    weight: 3,
    strong: true,
  },
  {
    label: "coding-action",
    pattern:
      /\b(write|implement|refactor|debug|fix|patch|add|update|remove)\b.{0,70}\b(code|function|class|module|script|test|bug|error|compile|build)\b/,
    weight: 2,
  },
  {
    label: "script-request",
    pattern: /\b(write|create|build)\b.{0,35}\b(script|program|automation)\b/,
    weight: 2,
  },
  {
    label: "test-debug",
    pattern: /\b(unit test|integration test|test case|failing test|stack trace|compile error|type error|eslint|tsc|pytest)\b/,
    weight: 2,
  },
  {
    label: "review",
    pattern: /\b(code review|pr review|pull request)\b/,
    weight: 2,
  },
];

export function analyzeRouteIntent(message: string): RouteIntentAnalysis {
  const text = String(message ?? "").toLowerCase();
  if (!text.trim()) {
    return {
      slot: "default",
      planningScore: 0,
      codingScore: 0,
      planningSignals: [],
      codingSignals: [],
    };
  }

  let planningScore = 0;
  let codingScore = 0;
  const planningSignals: string[] = [];
  const codingSignals: string[] = [];
  let planningStrong = false;
  let codingStrong = false;

  for (const signal of PLANNING_SIGNALS) {
    if (!signal.pattern.test(text)) {
      continue;
    }
    planningScore += signal.weight;
    planningSignals.push(signal.label);
    planningStrong = planningStrong || signal.strong === true;
  }
  for (const signal of CODING_SIGNALS) {
    if (!signal.pattern.test(text)) {
      continue;
    }
    codingScore += signal.weight;
    codingSignals.push(signal.label);
    codingStrong = codingStrong || signal.strong === true;
  }

  // If user explicitly asks for a task plan / checklist / roadmap, keep this in planning route
  // even when coding keywords also appear.
  const explicitPlanningRequest =
    /\b(list of tasks|task list|task breakdown|todo list|checklist|roadmap|implementation plan|next steps?)\b/.test(
      text,
    ) &&
    /\b(plan|planning|create|draft|build|make|come up with|outline)\b/.test(text);
  if (explicitPlanningRequest) {
    return {
      slot: "planning",
      planningScore: Math.max(planningScore, 3),
      codingScore,
      planningSignals: planningSignals.length > 0 ? planningSignals : ["task-list"],
      codingSignals,
    };
  }

  if (codingStrong && codingScore >= 3 && codingScore >= planningScore) {
    return {
      slot: "coding",
      planningScore,
      codingScore,
      planningSignals,
      codingSignals,
    };
  }
  if (codingScore >= 4 && codingScore >= planningScore + 1) {
    return {
      slot: "coding",
      planningScore,
      codingScore,
      planningSignals,
      codingSignals,
    };
  }
  if (planningStrong && planningScore >= 3 && planningScore >= codingScore) {
    return {
      slot: "planning",
      planningScore,
      codingScore,
      planningSignals,
      codingSignals,
    };
  }
  if (planningScore >= 3 && planningScore >= codingScore) {
    return {
      slot: "planning",
      planningScore,
      codingScore,
      planningSignals,
      codingSignals,
    };
  }
  if (codingScore >= 2 && planningScore === 0) {
    return {
      slot: "coding",
      planningScore,
      codingScore,
      planningSignals,
      codingSignals,
    };
  }
  return {
    slot: "default",
    planningScore,
    codingScore,
    planningSignals,
    codingSignals,
  };
}

export function chooseRouteSlot(message: string): "default" | "planning" | "coding" {
  return analyzeRouteIntent(message).slot;
}

function formatProviderError(route: RoutingTarget | undefined, slot: string, channel: GatewayChannelId, message: string): string {
  const provider = route?.provider ?? "unknown";
  const model = route?.model ?? "unknown";
  return `Provider error (${channel}) route=${slot} via ${provider}/${model}. ${message}`;
}

function isLikelyTokenExhaustion(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("context length") ||
    text.includes("context window") ||
    text.includes("maximum context") ||
    text.includes("too many tokens") ||
    text.includes("token limit")
  );
}

function isNonRecoverableProviderError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("not configured") ||
    text.includes("credentials missing") ||
    text.includes("model '") ||
    text.includes("not supported by the provider runtime") ||
    text.includes("permission denied") ||
    text.includes("eacces") ||
    text.includes("eperm") ||
    text.includes("read-only file system") ||
    text.includes("enospc") ||
    text.includes("connection refused") ||
    text.includes("econnrefused") ||
    text.includes("enotfound") ||
    text.includes("network") ||
    text.includes("fetch failed") ||
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("aborted")
  );
}

function shouldAutoResumeAfterProviderError(message: string): boolean {
  const text = message.toLowerCase();
  if (isNonRecoverableProviderError(message)) {
    return false;
  }
  if (isLikelyTokenExhaustion(message)) {
    return false;
  }
  return (
    text.includes("empty response") ||
    text.includes("non-empty response") ||
    text.includes("did not return an assistant response") ||
    text.includes("assistant response was empty")
  );
}

function isConnectivityProviderError(message: string): boolean {
  const text = String(message ?? "").toLowerCase();
  return (
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("connection refused") ||
    text.includes("econnrefused") ||
    text.includes("enotfound") ||
    text.includes("network") ||
    text.includes("fetch failed") ||
    text.includes("aborted")
  );
}

function isTimeoutLikeError(message: string): boolean {
  const text = String(message ?? "").toLowerCase();
  return text.includes("timed out") || text.includes("timeout");
}

function hostLooksLocal(hostname: string): boolean {
  const host = String(hostname ?? "").trim().toLowerCase();
  if (!host) {
    return false;
  }
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) {
    return true;
  }
  if (host.startsWith("127.")) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) {
    return false;
  }
  const a = Number(ipv4[1]);
  const b = Number(ipv4[2]);
  if (a === 10) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  // Tailscale / CGNAT range (100.64.0.0/10)
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  return false;
}

function isLikelyLocalRoute(config: T560Config, route: RoutingTarget): boolean {
  const providerId = String(route.provider ?? "").trim().toLowerCase();
  if (!providerId) {
    return false;
  }
  if (providerId === "local-openai" || providerId.includes("local")) {
    return true;
  }
  const profile = config.providers?.[route.provider ?? ""];
  const baseUrl = String(profile?.baseUrl ?? "").trim();
  if (!baseUrl) {
    return false;
  }
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostLooksLocal(hostname);
  } catch {
    return false;
  }
}

function routeKey(route: RoutingTarget | undefined): string {
  const provider = String(route?.provider ?? "").trim();
  const model = String(route?.model ?? "").trim();
  if (!provider || !model) {
    return "";
  }
  return `${provider.toLowerCase()}::${model.toLowerCase()}`;
}

function chooseFallbackRoute(config: T560Config, failedRoute: RoutingTarget): RoutingTarget | null {
  const slots: Array<"default" | "planning" | "coding"> = ["default", "planning", "coding"];
  const failedKey = routeKey(failedRoute);
  const failedProvider = String(failedRoute.provider ?? "").trim().toLowerCase();
  const candidates = slots
    .map((slot) => resolveRoutingTarget(config, slot))
    .filter((route): route is RoutingTarget => Boolean(route?.provider && route?.model));

  const unique = Array.from(
    new Map(candidates.map((route) => [routeKey(route), route])).values()
  ).filter((route) => routeKey(route) && routeKey(route) !== failedKey);

  const differentProvider = unique.find(
    (route) => String(route.provider ?? "").trim().toLowerCase() !== failedProvider
  );
  return differentProvider ?? unique[0] ?? null;
}

function resolveChatTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const rawSec = Number(env.T560_CHAT_TIMEOUT_SEC ?? "");
  if (Number.isFinite(rawSec) && rawSec > 0) {
    return Math.min(MAX_CHAT_TIMEOUT_MS, Math.max(MIN_CHAT_TIMEOUT_MS, Math.floor(rawSec * 1000)));
  }
  const rawMs = Number(env.T560_CHAT_TIMEOUT_MS ?? "");
  if (Number.isFinite(rawMs) && rawMs > 0) {
    return Math.min(MAX_CHAT_TIMEOUT_MS, Math.max(MIN_CHAT_TIMEOUT_MS, Math.floor(rawMs)));
  }
  return DEFAULT_CHAT_TIMEOUT_MS;
}

function resolveLocalChatTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const rawSec = Number(env.T560_CHAT_TIMEOUT_LOCAL_SEC ?? "");
  if (Number.isFinite(rawSec) && rawSec > 0) {
    return Math.min(MAX_CHAT_TIMEOUT_MS, Math.max(MIN_LOCAL_CHAT_TIMEOUT_MS, Math.floor(rawSec * 1000)));
  }
  const rawMs = Number(env.T560_CHAT_TIMEOUT_LOCAL_MS ?? "");
  if (Number.isFinite(rawMs) && rawMs > 0) {
    return Math.min(MAX_CHAT_TIMEOUT_MS, Math.max(MIN_LOCAL_CHAT_TIMEOUT_MS, Math.floor(rawMs)));
  }
  return DEFAULT_LOCAL_CHAT_TIMEOUT_MS;
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

function resolveChatTimeoutForMessage(
  message: string,
  route: RoutingTarget,
  config: T560Config,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const localRoute = isLikelyLocalRoute(config, route);
  if (localRoute) {
    const base = resolveLocalChatTimeoutMs(env);
    if (!messageLikelyLongRunning(message)) {
      return base;
    }
    return Math.min(MAX_CHAT_TIMEOUT_MS, Math.max(base, 60 * 60_000));
  }
  const base = resolveChatTimeoutMs(env);
  if (!messageLikelyLongRunning(message)) {
    return base;
  }
  return Math.min(MAX_CHAT_TIMEOUT_MS, Math.max(base, 30 * 60_000));
}

function parseExplicitBoolean(value: string): boolean | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return null;
}

function allowFallbackFromLocal(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = parseExplicitBoolean(String(env.T560_ALLOW_FALLBACK_FROM_LOCAL ?? ""));
  if (explicit !== null) {
    return explicit;
  }
  return false;
}

function allowCrossSlotFallback(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = parseExplicitBoolean(String(env.T560_ALLOW_CROSS_SLOT_FALLBACK ?? ""));
  if (explicit !== null) {
    return explicit;
  }
  return false;
}

async function runWithTimeout<T>(params: {
  operation: Promise<T>;
  timeoutMs: number;
  timeoutMessage: string;
}): Promise<T> {
  const op = params.operation.then(
    (value) => ({ kind: "value" as const, value }),
    (error) => ({ kind: "error" as const, error })
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
  throw new Error(params.timeoutMessage);
}

export async function processChatMessage(
  input: GatewayInboundMessage
): Promise<ChatResponse> {
  const status = await readOnboardingStatus();
  let secureSetup: Awaited<ReturnType<typeof handleSecureSetupFlow>>;
  try {
    secureSetup = await handleSecureSetupFlow({
      workspaceDir: process.cwd(),
      sessionId: input.sessionId,
      message: input.message,
    });
  } catch (error: unknown) {
    const setupError = error instanceof Error ? error.message : String(error);
    return {
      role: "assistant",
      message: `Secure setup error: ${setupError}`,
      thinking: null,
      toolCalls: [],
      mode: status.onboarded ? "provider" : "foundation",
      provider: null,
      model: null,
      onboardingRequired: !status.onboarded,
      missing: status.onboarded ? [] : status.missing
    };
  }
  if (secureSetup.handled) {
    return {
      role: "assistant",
      message: secureSetup.message,
      thinking: null,
      toolCalls: [],
      mode: status.onboarded ? "provider" : "foundation",
      provider: null,
      model: null,
      onboardingRequired: !status.onboarded,
      missing: status.onboarded ? [] : status.missing
    };
  }

  if (!status.onboarded) {
    return {
      role: "assistant",
      message: foundationMessage(input.message, input.channel, status.missing),
      thinking: null,
      toolCalls: [],
      mode: "foundation",
      provider: null,
      model: null,
      onboardingRequired: true,
      missing: status.missing
    };
  }

  const routeIntent = analyzeRouteIntent(input.message);
  const slot = routeIntent.slot;
  const route =
    resolveRoutingTarget(status.config, slot) ?? resolveRoutingTarget(status.config, "default");

  emitAgentEvent({
    stream: "status",
    sessionId: input.sessionId,
    channel: input.channel,
    timestamp: Date.now(),
    data: {
      phase: "route",
      slot,
      routeIntent,
      provider: route?.provider,
      model: route?.model
    }
  });

  if (!route?.provider || !route.model) {
    return {
      role: "assistant",
      message: formatProviderError(route, slot, input.channel, "Routing configuration is incomplete."),
      thinking: null,
      toolCalls: [],
      mode: "provider",
      provider: route?.provider ?? null,
      model: route?.model ?? null,
      onboardingRequired: false,
      missing: []
    };
  }

  try {
    const chatTimeoutMs = resolveChatTimeoutForMessage(input.message, route, status.config);
    const response = await runWithTimeout({
      operation: chatWithProvider({
        config: status.config,
        target: route,
        message: input.message,
        sessionId: input.sessionId,
        externalUserId: input.externalUserId,
        channel: input.channel
      }),
      timeoutMs: chatTimeoutMs,
      timeoutMessage: `Chat request timed out after ${Math.round(chatTimeoutMs / 1000)}s.`,
    });

    return {
      role: "assistant",
      message: response.message,
      thinking: response.thinking,
      toolCalls: response.toolCalls,
      mode: "provider",
      provider: response.provider,
      model: response.model,
      onboardingRequired: false,
      missing: []
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const localRoute = isLikelyLocalRoute(status.config, route);
    const localFallbackAllowed = allowFallbackFromLocal(process.env);
    const crossSlotFallbackAllowed = allowCrossSlotFallback(process.env);
    const skipFallbackForLocalTimeout =
      localRoute &&
      isTimeoutLikeError(errorMessage) &&
      String(process.env.T560_ALLOW_FALLBACK_ON_LOCAL_TIMEOUT ?? "").trim() !== "1";
    const skipFallbackForLocalRoute = localRoute && !localFallbackAllowed;
    if (
      isConnectivityProviderError(errorMessage) &&
      !skipFallbackForLocalTimeout &&
      !skipFallbackForLocalRoute &&
      crossSlotFallbackAllowed
    ) {
      const fallbackRoute = chooseFallbackRoute(status.config, route);
      if (fallbackRoute) {
        try {
          const chatTimeoutMs = resolveChatTimeoutForMessage(input.message, fallbackRoute, status.config);
          const fallback = await runWithTimeout({
            operation: chatWithProvider({
              config: status.config,
              target: fallbackRoute,
              message: input.message,
              sessionId: input.sessionId,
              externalUserId: input.externalUserId,
              channel: input.channel
            }),
            timeoutMs: chatTimeoutMs,
            timeoutMessage: `Fallback chat request timed out after ${Math.round(chatTimeoutMs / 1000)}s.`,
          });
          return {
            role: "assistant",
            message: [
              `Primary route ${route.provider}/${route.model} failed (${errorMessage}).`,
              `Used fallback ${fallbackRoute.provider}/${fallbackRoute.model}.`,
              "",
              fallback.message,
            ].join("\n"),
            thinking: fallback.thinking,
            toolCalls: fallback.toolCalls,
            mode: "provider",
            provider: fallback.provider,
            model: fallback.model,
            onboardingRequired: false,
            missing: []
          };
        } catch (fallbackError: unknown) {
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          return {
            role: "assistant",
            message: formatProviderError(
              route,
              slot,
              input.channel,
              `Primary route failed (${errorMessage}); fallback ${fallbackRoute.provider}/${fallbackRoute.model} failed (${fallbackMessage}).`
            ),
            thinking: null,
            toolCalls: [],
            mode: "provider",
            provider: route.provider ?? null,
            model: route.model ?? null,
            onboardingRequired: false,
            missing: []
          };
        }
      }
    }
    if (shouldAutoResumeAfterProviderError(errorMessage)) {
      try {
        const chatTimeoutMs = resolveChatTimeoutForMessage(input.message, route, status.config);
        const resumed = await runWithTimeout({
          operation: chatWithProvider({
            config: status.config,
            target: route,
            message:
              "Continue from the current session state and finish the user's previous request. Do not ask them to restate it.",
            sessionId: input.sessionId,
            externalUserId: input.externalUserId,
            channel: input.channel
          }),
          timeoutMs: chatTimeoutMs,
          timeoutMessage: `Auto-resume request timed out after ${Math.round(chatTimeoutMs / 1000)}s.`,
        });
        return {
          role: "assistant",
          message: resumed.message,
          thinking: resumed.thinking,
          toolCalls: resumed.toolCalls,
          mode: "provider",
          provider: resumed.provider,
          model: resumed.model,
          onboardingRequired: false,
          missing: []
        };
      } catch (resumeError: unknown) {
        const resumeMessage = resumeError instanceof Error ? resumeError.message : String(resumeError);
        return {
          role: "assistant",
          message: formatProviderError(
            route,
            slot,
            input.channel,
            `Primary run failed (${errorMessage}); auto-resume failed (${resumeMessage}).`
          ),
          thinking: null,
          toolCalls: [],
          mode: "provider",
          provider: route.provider ?? null,
          model: route.model ?? null,
          onboardingRequired: false,
          missing: []
        };
      }
    }
    return {
      role: "assistant",
      message: formatProviderError(route, slot, input.channel, errorMessage),
      thinking: null,
      toolCalls: [],
      mode: "provider",
      provider: route.provider ?? null,
      model: route.model ?? null,
      onboardingRequired: false,
      missing: []
    };
  }
}
