import type { GatewayChannelId, GatewayInboundMessage } from "../gateway/types.js";
import { readOnboardingStatus, resolveRoutingTarget, type RoutingTarget } from "../config/state.js";
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

function foundationMessage(input: string, source: GatewayChannelId, missing: string[]): string {
  const missingText = missing.join(", ");
  return [
    `Foundation mode (${source}) is active.`,
    `You said: \"${input}\"`,
    `To unlock provider inference, complete onboarding fields: ${missingText}.`
  ].join(" ");
}

function chooseRouteSlot(message: string): "default" | "planning" | "coding" {
  const text = message.toLowerCase();
  if (
    text.includes("plan") ||
    text.includes("strategy") ||
    text.includes("roadmap") ||
    text.includes("architecture") ||
    text.includes("design doc")
  ) {
    return "planning";
  }
  if (
    text.includes("code") ||
    text.includes("refactor") ||
    text.includes("bug") ||
    text.includes("test") ||
    text.includes("typescript") ||
    text.includes("python") ||
    text.includes("implement")
  ) {
    return "coding";
  }
  return "default";
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
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("aborted")
  );
}

function shouldAutoResumeAfterProviderError(message: string): boolean {
  if (isNonRecoverableProviderError(message)) {
    return false;
  }
  if (isLikelyTokenExhaustion(message)) {
    return false;
  }
  return true;
}

export async function processChatMessage(
  input: GatewayInboundMessage
): Promise<ChatResponse> {
  const status = await readOnboardingStatus();
  const secureSetup = await handleSecureSetupFlow({
    workspaceDir: process.cwd(),
    sessionId: input.sessionId,
    message: input.message,
  });
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

  const slot = chooseRouteSlot(input.message);
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
    const response = await chatWithProvider({
      config: status.config,
      target: route,
      message: input.message,
      sessionId: input.sessionId,
      externalUserId: input.externalUserId,
      channel: input.channel
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
    if (shouldAutoResumeAfterProviderError(errorMessage)) {
      try {
        const resumed = await chatWithProvider({
          config: status.config,
          target: route,
          message:
            "Continue from the current session state and finish the user's previous request. Do not ask them to restate it.",
          sessionId: input.sessionId,
          externalUserId: input.externalUserId,
          channel: input.channel
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
