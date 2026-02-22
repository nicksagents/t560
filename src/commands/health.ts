// @ts-nocheck
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadSessionStore } from "../config/sessions.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { resolveHeartbeatSummaryForAgent, } from "../infra/heartbeat-runner.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { theme } from "../terminal/theme.js";
const DEFAULT_TIMEOUT_MS = 10_000;
const debugHealth = (...args) => {
    if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_HEALTH)) {
        console.warn("[health:debug]", ...args);
    }
};
const formatDurationParts = (ms) => {
    if (!Number.isFinite(ms)) {
        return "unknown";
    }
    if (ms < 1000) {
        return `${Math.max(0, Math.round(ms))}ms`;
    }
    const units = [
        { label: "w", size: 7 * 24 * 60 * 60 * 1000 },
        { label: "d", size: 24 * 60 * 60 * 1000 },
        { label: "h", size: 60 * 60 * 1000 },
        { label: "m", size: 60 * 1000 },
        { label: "s", size: 1000 },
    ];
    let remaining = Math.max(0, Math.floor(ms));
    const parts = [];
    for (const unit of units) {
        const value = Math.floor(remaining / unit.size);
        if (value > 0) {
            parts.push(`${value}${unit.label}`);
            remaining -= value * unit.size;
        }
    }
    if (parts.length === 0) {
        return "0s";
    }
    return parts.join(" ");
};
const resolveHeartbeatSummary = (cfg, agentId) => resolveHeartbeatSummaryForAgent(cfg, agentId);
const resolveAgentOrder = (cfg) => {
    const defaultAgentId = resolveDefaultAgentId(cfg);
    const entries = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
    const seen = new Set();
    const ordered = [];
    for (const entry of entries) {
        if (!entry || typeof entry !== "object") {
            continue;
        }
        if (typeof entry.id !== "string" || !entry.id.trim()) {
            continue;
        }
        const id = normalizeAgentId(entry.id);
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        ordered.push({ id, name: typeof entry.name === "string" ? entry.name : undefined });
    }
    if (!seen.has(defaultAgentId)) {
        ordered.unshift({ id: defaultAgentId });
    }
    if (ordered.length === 0) {
        ordered.push({ id: defaultAgentId });
    }
    return { defaultAgentId, ordered };
};
const buildSessionSummary = (storePath) => {
    const store = loadSessionStore(storePath);
    const sessions = Object.entries(store)
        .filter(([key]) => key !== "global" && key !== "unknown")
        .map(([key, entry]) => ({ key, updatedAt: entry?.updatedAt ?? 0 }))
        .toSorted((a, b) => b.updatedAt - a.updatedAt);
    const recent = sessions.slice(0, 5).map((s) => ({
        key: s.key,
        updatedAt: s.updatedAt || null,
        age: s.updatedAt ? Date.now() - s.updatedAt : null,
    }));
    return {
        path: storePath,
        count: sessions.length,
        recent,
    };
};
const isAccountEnabled = (account) => {
    if (!account || typeof account !== "object") {
        return true;
    }
    const enabled = account.enabled;
    return enabled !== false;
};
const asRecord = (value) => value && typeof value === "object" ? value : null;
const formatProbeLine = (probe, opts = {}) => {
    const record = asRecord(probe);
    if (!record) {
        return null;
    }
    const ok = typeof record.ok === "boolean" ? record.ok : undefined;
    if (ok === undefined) {
        return null;
    }
    const elapsedMs = typeof record.elapsedMs === "number" ? record.elapsedMs : null;
    const status = typeof record.status === "number" ? record.status : null;
    const error = typeof record.error === "string" ? record.error : null;
    const bot = asRecord(record.bot);
    const botUsername = bot && typeof bot.username === "string" ? bot.username : null;
    const webhook = asRecord(record.webhook);
    const webhookUrl = webhook && typeof webhook.url === "string" ? webhook.url : null;
    const usernames = new Set();
    if (botUsername) {
        usernames.add(botUsername);
    }
    for (const extra of opts.botUsernames ?? []) {
        if (extra) {
            usernames.add(extra);
        }
    }
    if (ok) {
        let label = "ok";
        if (usernames.size > 0) {
            label += ` (@${Array.from(usernames).join(", @")})`;
        }
        if (elapsedMs != null) {
            label += ` (${elapsedMs}ms)`;
        }
        if (webhookUrl) {
            label += ` - webhook ${webhookUrl}`;
        }
        return label;
    }
    let label = `failed (${status ?? "unknown"})`;
    if (error) {
        label += ` - ${error}`;
    }
    return label;
};
const formatAccountProbeTiming = (summary) => {
    const probe = asRecord(summary.probe);
    if (!probe) {
        return null;
    }
    const elapsedMs = typeof probe.elapsedMs === "number" ? Math.round(probe.elapsedMs) : null;
    const ok = typeof probe.ok === "boolean" ? probe.ok : null;
    if (elapsedMs == null && ok !== true) {
        return null;
    }
    const accountId = summary.accountId || "default";
    const botRecord = asRecord(probe.bot);
    const botUsername = botRecord && typeof botRecord.username === "string" ? botRecord.username : null;
    const handle = botUsername ? `@${botUsername}` : accountId;
    const timing = elapsedMs != null ? `${elapsedMs}ms` : "ok";
    return `${handle}:${accountId}:${timing}`;
};
const isProbeFailure = (summary) => {
    const probe = asRecord(summary.probe);
    if (!probe) {
        return false;
    }
    const ok = typeof probe.ok === "boolean" ? probe.ok : null;
    return ok === false;
};
function styleHealthChannelLine(line) {
    const colon = line.indexOf(":");
    if (colon === -1) {
        return line;
    }
    const label = line.slice(0, colon + 1);
    const detail = line.slice(colon + 1).trimStart();
    const normalized = detail.toLowerCase();
    const applyPrefix = (prefix, color) => `${label} ${color(detail.slice(0, prefix.length))}${detail.slice(prefix.length)}`;
    if (normalized.startsWith("failed")) {
        return applyPrefix("failed", theme.error);
    }
    if (normalized.startsWith("ok")) {
        return applyPrefix("ok", theme.success);
    }
    if (normalized.startsWith("linked")) {
        return applyPrefix("linked", theme.success);
    }
    if (normalized.startsWith("configured")) {
        return applyPrefix("configured", theme.success);
    }
    if (normalized.startsWith("not linked")) {
        return applyPrefix("not linked", theme.warn);
    }
    if (normalized.startsWith("not configured")) {
        return applyPrefix("not configured", theme.muted);
    }
}
