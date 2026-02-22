export type GatewayChannelId = "webchat" | "telegram" | "terminal";

export type GatewayInboundMessage = {
  channel: GatewayChannelId;
  message: string;
  sessionId: string;
  externalUserId: string;
  receivedAt: number;
};

export type GatewayEventSubscription = {
  sessionId?: string;
  onEvent: (event: import("../agents/agent-events.js").AgentEvent) => void;
};
