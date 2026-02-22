const HEARTBEAT_MESSAGES = new Set([
  "heartbeat",
  "heart beat",
  "heart-beat",
  "/heartbeat",
  "ping",
  "/ping",
  "healthcheck",
  "health check",
  "health-check",
  "/health"
]);

export function isHeartbeatCheckMessage(value: string): boolean {
  return HEARTBEAT_MESSAGES.has(value.trim().toLowerCase());
}
