export function jsonResult(payload: Record<string, unknown>): Record<string, unknown> {
  return payload;
}

export function toolErrorResult(toolName: string, message: string): Record<string, unknown> {
  return {
    status: "error",
    tool: toolName,
    error: message
  };
}
