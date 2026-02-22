import { processChatMessage, type ChatResponse } from "../agent/chat-service.js";
import type { GatewayInboundMessage } from "./types.js";

export async function routeGatewayMessage(input: GatewayInboundMessage): Promise<ChatResponse> {
  return processChatMessage(input);
}
