// @ts-nocheck
import { spawn } from "node:child_process";
import net from "node:net";
import process from "node:process";
import { loadDotEnv } from "../infra/dotenv.js";
import { normalizeEnv } from "../infra/env.js";
import { ensureT560CliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import { getPrimaryCommand, hasHelpOrVersion } from "./argv.js";
import { tryRouteCli } from "./route.js";
function hasWizardCompleted(cfg) {
    const lastRunAt = cfg.wizard?.lastRunAt;
    return typeof lastRunAt === "string" && lastRunAt.trim().length > 0;
}
function normalizeAllowList(entries) {
    if (!Array.isArray(entries)) {
        return [];
    }
    return entries
        .map((entry) => String(entry ?? "").trim())
        .filter((entry) => entry.length > 0 && entry !== "*");
}
async function checkTelegramReadiness(cfg) {
    const reasons = [];
    const telegramCfg = cfg.channels?.telegram;
    if (telegramCfg?.enabled === false) {
        reasons.push("Telegram is disabled (channels.telegram.enabled=false).");
        return { ready: false, reasons };
    }
    const { resolveTelegramToken } = await import("../telegram/token.js");
    const tokenResolution = resolveTelegramToken(cfg);
    if (!tokenResolution.token) {
        reasons.push("Telegram bot token is missing. Set channels.telegram.botToken/tokenFile or TELEGRAM_BOT_TOKEN.");
        return { ready: false, reasons };
    }
    try {
        const { probeTelegram } = await import("../telegram/probe.js");
        const probe = await probeTelegram(tokenResolution.token, 3500, typeof telegramCfg?.proxy === "string" ? telegramCfg.proxy : undefined);
        if (!probe.ok) {
            const detail = probe.error ? ` (${probe.error})` : "";
            reasons.push(`Telegram token check failed${detail}.`);
        }
    }
    catch (err) {
        reasons.push(`Telegram connectivity probe failed (${err instanceof Error ? err.message : String(err)}).`);
    }
    const dmPolicyRaw = typeof telegramCfg?.dmPolicy === "string" ? telegramCfg.dmPolicy.trim() : "";
    const dmPolicy = dmPolicyRaw === "pairing" ||
        dmPolicyRaw === "allowlist" ||
        dmPolicyRaw === "open" ||
        dmPolicyRaw === "disabled"
        ? dmPolicyRaw
        : "pairing";
    if (dmPolicy === "pairing" || dmPolicy === "allowlist") {
        const configuredAllow = normalizeAllowList(telegramCfg?.allowFrom);
        let pairedAllow = [];
        try {
            const { readChannelAllowFromStore } = await import("../pairing/pairing-store.js");
            pairedAllow = await readChannelAllowFromStore("telegram");
        }
        catch {
            // Best-effort only; missing store should not crash startup routing.
        }
        if (configuredAllow.length === 0 && pairedAllow.length === 0) {
            reasons.push(dmPolicy === "pairing"
                ? "Telegram has no approved DM users yet. Approve at least one pairing code."
                : "Telegram DM allowlist is empty. Add channels.telegram.allowFrom entries.");
        }
    }
    return {
        ready: reasons.length === 0,
        reasons,
    };
}
function checkWebchatReadiness(cfg) {
    const reasons = [];
    const mode = cfg.gateway?.mode ?? "local";
    if (mode !== "local") {
        reasons.push('Gateway mode must be "local" for local webchat + terminal startup.');
    }
    if (cfg.gateway?.controlUi?.enabled === false) {
        reasons.push("Local webchat is disabled (gateway.controlUi.enabled=false).");
    }
    return {
        ready: reasons.length === 0,
        reasons,
    };
}
async function checkNoArgStartupReadiness(cfg) {
    const reasons = [];
    if (!hasWizardCompleted(cfg)) {
        reasons.push("Onboarding has not been completed.");
    }
    const webchat = checkWebchatReadiness(cfg);
    if (!webchat.ready) {
        reasons.push(...webchat.reasons);
    }
    const telegram = await checkTelegramReadiness(cfg);
    if (!telegram.ready) {
        reasons.push(...telegram.reasons);
    }
    return {
        ready: reasons.length === 0,
        reasons,
    };
}
async function probeLocalGatewayPort(port, timeoutMs = 800) {
    return await new Promise((resolve) => {
        const socket = net.createConnection({ host: "127.0.0.1", port });
        let settled = false;
        const finish = (ok) => {
            if (settled) {
                return;
            }
            settled = true;
            socket.destroy();
            resolve(ok);
        };
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.setTimeout(timeoutMs, () => finish(false));
    });
}
async function ensureLocalGatewayReady(cfg) {
    if ((cfg.gateway?.mode ?? "local") !== "local") {
        return true;
    }
    const port = resolveGatewayPort(cfg);
    if (await probeLocalGatewayPort(port)) {
        return true;
    }
    const startedAt = Date.now();
    const bindMode = cfg.gateway?.bind ?? "loopback";
    const startArgs = [...process.execArgv, process.argv[1], "gateway", "--allow-unconfigured", "--force"];
    // No-arg UX depends on local websocket + webchat at 127.0.0.1.
    // If config currently binds elsewhere, force loopback for auto-start.
    if (bindMode !== "loopback") {
        startArgs.push("--bind", "loopback");
    }
    console.error(`[t560] gateway not detected on 127.0.0.1:${port}; starting local gateway${bindMode !== "loopback" ? " (loopback override)" : ""}…`);
    const child = spawn(process.execPath, startArgs, {
        stdio: "ignore",
        detached: true,
        env: {
            ...process.env,
            T560_NO_RESPAWN: "1",
        },
    });
    child.unref();
    const deadline = Date.now() + 35_000;
    let nextProgressAt = Date.now() + 3000;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (await probeLocalGatewayPort(port)) {
            const elapsedMs = Date.now() - startedAt;
            console.error(`[t560] gateway ready in ${Math.max(1, Math.round(elapsedMs / 1000))}s.`);
            return true;
        }
        if (Date.now() >= nextProgressAt) {
            console.error("[t560] waiting for gateway startup…");
            nextProgressAt = Date.now() + 3000;
        }
    }
    console.error("[t560] gateway did not become ready in time; opening gateway command output. If this repeats, run: t560 gateway --force --verbose");
    return false;
}
async function applyDefaultCommandForNoArgs(argv) {
    if (hasHelpOrVersion(argv) || getPrimaryCommand(argv)) {
        return argv;
    }
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.exists || !snapshot.valid) {
        return [...argv, "onboard"];
    }
    const readiness = await checkNoArgStartupReadiness(snapshot.config);
    if (!readiness.ready) {
        console.error("[t560] setup incomplete; opening onboarding.");
        for (const reason of readiness.reasons) {
            console.error(`[t560] - ${reason}`);
        }
        return [...argv, "onboard"];
    }
    const ready = await ensureLocalGatewayReady(snapshot.config);
    if (!ready) {
        return [...argv, "gateway", "--allow-unconfigured"];
    }
    return [...argv, "tui"];
}
export function rewriteUpdateFlagArgv(argv) {
    const index = argv.indexOf("--update");
    if (index === -1) {
        return argv;
    }
    const next = [...argv];
    next.splice(index, 1, "update");
    return next;
}
export async function runCli(argv = process.argv) {
    const normalizedArgv = stripWindowsNodeExec(argv);
    loadDotEnv({ quiet: true });
    normalizeEnv();
    const effectiveArgv = await applyDefaultCommandForNoArgs(normalizedArgv);
    ensureT560CliOnPath();
    // Enforce the minimum supported runtime before doing any work.
    assertSupportedRuntime();
    if (await tryRouteCli(effectiveArgv)) {
    }
}
