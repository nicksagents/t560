// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import { normalizeAgentId, } from "../routing/session-key.js";
import { existsDir, safeReadDir, } from "./state-migrations.fs.js";
let autoMigrateChecked = false;
let autoMigrateStateDirChecked = false;
function isSurfaceGroupKey(key) {
    return key.includes(":group:") || key.includes(":channel:");
}
function isLegacyGroupKey(key) {
    const trimmed = key.trim();
    if (!trimmed) {
        return false;
    }
    if (trimmed.startsWith("group:")) {
        return true;
    }
    const lower = trimmed.toLowerCase();
    if (!lower.includes("@g.us")) {
        return false;
    }
    // Legacy WhatsApp group keys: bare JID or "whatsapp:<jid>" without explicit ":group:" kind.
    if (!trimmed.includes(":")) {
        return true;
    }
    if (lower.startsWith("whatsapp:") && !trimmed.includes(":group:")) {
        return true;
    }
    return false;
}
function canonicalizeSessionKeyForAgent(params) {
    const agentId = normalizeAgentId(params.agentId);
    const raw = params.key.trim();
    if (!raw) {
        return raw;
    }
    if (raw.toLowerCase() === "global" || raw.toLowerCase() === "unknown") {
        return raw.toLowerCase();
    }
    const canonicalMain = canonicalizeMainSessionAlias({
        cfg: { session: { scope: params.scope, mainKey: params.mainKey } },
        agentId,
        sessionKey: raw,
    });
    if (canonicalMain !== raw) {
        return canonicalMain.toLowerCase();
    }
    if (raw.toLowerCase().startsWith("agent:")) {
        return raw.toLowerCase();
    }
    if (raw.toLowerCase().startsWith("subagent:")) {
        const rest = raw.slice("subagent:".length);
        return `agent:${agentId}:subagent:${rest}`.toLowerCase();
    }
    if (raw.startsWith("group:")) {
        const id = raw.slice("group:".length).trim();
        if (!id) {
            return raw;
        }
        const channel = id.toLowerCase().includes("@g.us") ? "whatsapp" : "unknown";
        return `agent:${agentId}:${channel}:group:${id}`.toLowerCase();
    }
    if (!raw.includes(":") && raw.toLowerCase().includes("@g.us")) {
        return `agent:${agentId}:whatsapp:group:${raw}`.toLowerCase();
    }
    if (raw.toLowerCase().startsWith("whatsapp:") && raw.toLowerCase().includes("@g.us")) {
        const remainder = raw.slice("whatsapp:".length).trim();
        const cleaned = remainder.replace(/^group:/i, "").trim();
        if (cleaned && !isSurfaceGroupKey(raw)) {
            return `agent:${agentId}:whatsapp:group:${cleaned}`.toLowerCase();
        }
    }
    if (isSurfaceGroupKey(raw)) {
        return `agent:${agentId}:${raw}`.toLowerCase();
    }
    return `agent:${agentId}:${raw}`.toLowerCase();
}
function pickLatestLegacyDirectEntry(store) {
    let best = null;
    let bestUpdated = -1;
    for (const [key, entry] of Object.entries(store)) {
        if (!entry || typeof entry !== "object") {
            continue;
        }
        const normalized = key.trim();
        if (!normalized) {
            continue;
        }
        if (normalized === "global") {
            continue;
        }
        if (normalized.startsWith("agent:")) {
            continue;
        }
        if (normalized.toLowerCase().startsWith("subagent:")) {
            continue;
        }
        if (isLegacyGroupKey(normalized) || isSurfaceGroupKey(normalized)) {
            continue;
        }
        const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
        if (updatedAt > bestUpdated) {
            bestUpdated = updatedAt;
            best = entry;
        }
    }
    return best;
}
function normalizeSessionEntry(entry) {
    const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : null;
    if (!sessionId) {
        return null;
    }
    const updatedAt = typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
        ? entry.updatedAt
        : Date.now();
    const normalized = { ...entry, sessionId, updatedAt };
    const rec = normalized;
    if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") {
        rec.groupChannel = rec.room;
    }
    delete rec.room;
    return normalized;
}
function resolveUpdatedAt(entry) {
    return typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
        ? entry.updatedAt
        : 0;
}
function mergeSessionEntry(params) {
    if (!params.existing) {
        return params.incoming;
    }
    const existingUpdated = resolveUpdatedAt(params.existing);
    const incomingUpdated = resolveUpdatedAt(params.incoming);
    if (incomingUpdated > existingUpdated) {
        return params.incoming;
    }
    if (incomingUpdated < existingUpdated) {
        return params.existing;
    }
    return params.preferIncomingOnTie ? params.incoming : params.existing;
}
function canonicalizeSessionStore(params) {
    const canonical = {};
    const meta = new Map();
    const legacyKeys = [];
    for (const [key, entry] of Object.entries(params.store)) {
        if (!entry || typeof entry !== "object") {
            continue;
        }
        const canonicalKey = canonicalizeSessionKeyForAgent({
            key,
            agentId: params.agentId,
            mainKey: params.mainKey,
            scope: params.scope,
        });
        const isCanonical = canonicalKey === key;
        if (!isCanonical) {
            legacyKeys.push(key);
        }
        const existing = canonical[canonicalKey];
        if (!existing) {
            canonical[canonicalKey] = entry;
            meta.set(canonicalKey, { isCanonical, updatedAt: resolveUpdatedAt(entry) });
            continue;
        }
        const existingMeta = meta.get(canonicalKey);
        const incomingUpdated = resolveUpdatedAt(entry);
        const existingUpdated = existingMeta?.updatedAt ?? resolveUpdatedAt(existing);
        if (incomingUpdated > existingUpdated) {
            canonical[canonicalKey] = entry;
            meta.set(canonicalKey, { isCanonical, updatedAt: incomingUpdated });
            continue;
        }
        if (incomingUpdated < existingUpdated) {
            continue;
        }
        if (existingMeta?.isCanonical && !isCanonical) {
            continue;
        }
        if (!existingMeta?.isCanonical && isCanonical) {
            canonical[canonicalKey] = entry;
            meta.set(canonicalKey, { isCanonical, updatedAt: incomingUpdated });
            continue;
        }
    }
    return { store: canonical, legacyKeys };
}
function listLegacySessionKeys(params) {
    const legacy = [];
    for (const key of Object.keys(params.store)) {
        const canonical = canonicalizeSessionKeyForAgent({
            key,
            agentId: params.agentId,
            mainKey: params.mainKey,
            scope: params.scope,
        });
        if (canonical !== key) {
            legacy.push(key);
        }
    }
    return legacy;
}
function emptyDirOrMissing(dir) {
    if (!existsDir(dir)) {
        return true;
    }
    return safeReadDir(dir).length === 0;
}
function removeDirIfEmpty(dir) {
    if (!existsDir(dir)) {
        return;
    }
    if (!emptyDirOrMissing(dir)) {
        return;
    }
    try {
        fs.rmdirSync(dir);
    }
    catch {
        // ignore
    }
}
export function resetAutoMigrateLegacyStateForTest() {
    autoMigrateChecked = false;
}
export function resetAutoMigrateLegacyAgentDirForTest() {
    resetAutoMigrateLegacyStateForTest();
}
export function resetAutoMigrateLegacyStateDirForTest() {
    autoMigrateStateDirChecked = false;
}
function resolveSymlinkTarget(linkPath) {
    try {
        const target = fs.readlinkSync(linkPath);
        return path.resolve(path.dirname(linkPath), target);
    }
    catch {
        return null;
    }
}
function formatStateDirMigration(legacyDir, targetDir) {
    return `State dir: ${legacyDir} → ${targetDir} (legacy path now symlinked)`;
}
function isDirPath(filePath) {
    try {
        return fs.statSync(filePath).isDirectory();
    }
    catch {
        return false;
    }
}
function isWithinDir(targetPath, rootDir) {
    const relative = path.relative(path.resolve(rootDir), path.resolve(targetPath));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function isLegacyTreeSymlinkMirror(currentDir, realTargetDir) {
    let entries;
    try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
    }
    catch {
        return false;
    }
    if (entries.length === 0) {
        return false;
    }
    for (const entry of entries) {
        const entryPath = path.join(currentDir, entry.name);
        let stat;
        try {
            stat = fs.lstatSync(entryPath);
        }
        catch {
            return false;
        }
        if (stat.isSymbolicLink()) {
            const resolvedTarget = resolveSymlinkTarget(entryPath);
            if (!resolvedTarget) {
                return false;
            }
            let resolvedRealTarget;
            try {
                resolvedRealTarget = fs.realpathSync(resolvedTarget);
            }
            catch {
                return false;
            }
            if (!isWithinDir(resolvedRealTarget, realTargetDir)) {
                return false;
            }
            continue;
        }
        if (stat.isDirectory()) {
            if (!isLegacyTreeSymlinkMirror(entryPath, realTargetDir)) {
                return false;
            }
            continue;
        }
        return false;
    }
    return true;
}
function isLegacyDirSymlinkMirror(legacyDir, targetDir) {
    let realTargetDir;
    try {
        realTargetDir = fs.realpathSync(targetDir);
    }
    catch {
        return false;
    }
}
