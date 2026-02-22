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

export async function startGatewayRuntime(): Promise<GatewayRuntime> {
  const handleMessage = async (input: GatewayInboundMessage) => routeGatewayMessage(input);
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
