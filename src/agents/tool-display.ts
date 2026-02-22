// @ts-nocheck
import TOOL_DISPLAY_JSON from "./tool-display.json" with { type: "json" };
const TOOL_DISPLAY_CONFIG = TOOL_DISPLAY_JSON;
const FALLBACK = TOOL_DISPLAY_CONFIG.fallback ?? { emoji: "🧩" };
const TOOL_MAP = TOOL_DISPLAY_CONFIG.tools ?? {};
const DETAIL_LABEL_OVERRIDES = {
    agentId: "agent",
    sessionKey: "session",
    targetId: "target",
    targetUrl: "url",
    nodeId: "node",
    requestId: "request",
    messageId: "message",
    threadId: "thread",
    channelId: "channel",
    guildId: "guild",
    userId: "user",
    runTimeoutSeconds: "timeout",
    timeoutSeconds: "timeout",
    includeTools: "tools",
    pollQuestion: "poll",
    maxChars: "max chars",
};
const MAX_DETAIL_ENTRIES = 8;
function normalizeToolName(name) {
    return (name ?? "tool").trim();
}
function defaultTitle(name) {
    const cleaned = name.replace(/_/g, " ").trim();
    if (!cleaned) {
        return "Tool";
    }
    return cleaned
        .split(/\s+/)
        .map((part) => part.length <= 2 && part.toUpperCase() === part
        ? part
        : `${part.at(0)?.toUpperCase() ?? ""}${part.slice(1)}`)
        .join(" ");
}
function normalizeVerb(value) {
    const trimmed = value?.trim();
    if (!trimmed) {
        return undefined;
    }
    return trimmed.replace(/_/g, " ");
}
