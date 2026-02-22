// @ts-nocheck
import { cancel, isCancel } from "@clack/prompts";
import crypto from "node:crypto";
import { normalizeControlUiBasePath } from "../gateway/control-ui-shared.js";
import { isWSL } from "../infra/wsl.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";
import { shortenHomeInString, } from "../utils.js";
import { VERSION } from "../version.js";
export function guardCancel(value, runtime) {
    if (isCancel(value)) {
        cancel(stylePromptTitle("Setup cancelled.") ?? "Setup cancelled.");
        runtime.exit(0);
    }
    return value;
}
export function summarizeExistingConfig(config) {
    const rows = [];
    const defaults = config.agents?.defaults;
    if (defaults?.workspace) {
        rows.push(shortenHomeInString(`workspace: ${defaults.workspace}`));
    }
    if (defaults?.model) {
        const model = typeof defaults.model === "string" ? defaults.model : defaults.model.primary;
        if (model) {
            rows.push(shortenHomeInString(`model: ${model}`));
        }
    }
    if (config.gateway?.mode) {
        rows.push(shortenHomeInString(`gateway.mode: ${config.gateway.mode}`));
    }
    if (typeof config.gateway?.port === "number") {
        rows.push(shortenHomeInString(`gateway.port: ${config.gateway.port}`));
    }
    if (config.gateway?.bind) {
        rows.push(shortenHomeInString(`gateway.bind: ${config.gateway.bind}`));
    }
    if (config.gateway?.remote?.url) {
        rows.push(shortenHomeInString(`gateway.remote.url: ${config.gateway.remote.url}`));
    }
    if (config.skills?.install?.nodeManager) {
        rows.push(shortenHomeInString(`skills.nodeManager: ${config.skills.install.nodeManager}`));
    }
    return rows.length ? rows.join("\n") : "No key settings detected.";
}
export function randomToken() {
    return crypto.randomBytes(24).toString("hex");
}
export function normalizeGatewayTokenInput(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.trim();
}
export function printWizardHeader(runtime) {
    const header = [
        "TTTTTTT  555555   666666    000000",
        "   T     5       6        0      0",
        "   T     55555   666666   0      0",
        "   T         5   6    6   0      0",
        "   T     55555    66666    000000",
        "                ⚡ T560 ⚡",
        " ",
    ].join("\n");
    runtime.log(header);
}
export function applyWizardMetadata(cfg, params) {
    const commit = process.env.GIT_COMMIT?.trim() || process.env.GIT_SHA?.trim() || undefined;
    return {
        ...cfg,
        wizard: {
            ...cfg.wizard,
            lastRunAt: new Date().toISOString(),
            lastRunVersion: VERSION,
            lastRunCommit: commit,
            lastRunCommand: params.command,
            lastRunMode: params.mode,
        },
    };
}
export async function resolveBrowserOpenCommand() {
    const platform = process.platform;
    const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    const isSsh = Boolean(process.env.SSH_CLIENT) ||
        Boolean(process.env.SSH_TTY) ||
        Boolean(process.env.SSH_CONNECTION);
    if (isSsh && !hasDisplay && platform !== "win32") {
        return { argv: null, reason: "ssh-no-display" };
    }
    if (platform === "win32") {
        return {
            argv: ["cmd", "/c", "start", ""],
            command: "cmd",
            quoteUrl: true,
        };
    }
    if (platform === "darwin") {
        const hasOpen = await detectBinary("open");
        return hasOpen ? { argv: ["open"], command: "open" } : { argv: null, reason: "missing-open" };
    }
    if (platform === "linux") {
        const wsl = await isWSL();
        if (!hasDisplay && !wsl) {
            return { argv: null, reason: "no-display" };
        }
        if (wsl) {
            const hasWslview = await detectBinary("wslview");
            if (hasWslview) {
                return { argv: ["wslview"], command: "wslview" };
            }
            if (!hasDisplay) {
                return { argv: null, reason: "wsl-no-wslview" };
            }
        }
        const hasXdgOpen = await detectBinary("xdg-open");
        return hasXdgOpen
            ? { argv: ["xdg-open"], command: "xdg-open" }
            : { argv: null, reason: "missing-xdg-open" };
    }
    return { argv: null, reason: "unsupported-platform" };
}
export async function detectBrowserOpenSupport() {
    const resolved = await resolveBrowserOpenCommand();
    if (!resolved.argv) {
        return { ok: false, reason: resolved.reason };
    }
    return { ok: true, command: resolved.command };
}
export function formatControlUiSshHint(params) {
    const basePath = normalizeControlUiBasePath(params.basePath);
    const uiPath = basePath ? `${basePath}/` : "/";
    const localUrl = `http://localhost:${params.port}${uiPath}`;
    const authedUrl = params.token
        ? `${localUrl}#token=${encodeURIComponent(params.token)}`
        : undefined;
    const sshTarget = resolveSshTargetHint();
    return [
        "No GUI detected. Open from your computer:",
        `ssh -N -L ${params.port}:127.0.0.1:${params.port} ${sshTarget}`,
        "Then open:",
        localUrl,
        authedUrl,
        "Docs:",
        "https://docs.t560.ai/gateway/remote",
        "https://docs.t560.ai/web/control-ui",
    ]
        .filter(Boolean)
        .join("\n");
}
function resolveSshTargetHint() {
    const user = process.env.USER || process.env.LOGNAME || "user";
    const conn = process.env.SSH_CONNECTION?.trim().split(/\s+/);
    const host = conn?.[2] ?? "<host>";
    return `${user}@${host}`;
}
export async function openUrl(url) {
    if (shouldSkipBrowserOpenInTests()) {
        return false;
    }
    const resolved = await resolveBrowserOpenCommand();
    if (!resolved.argv) {
        return false;
    }
    const quoteUrl = resolved.quoteUrl === true;
    const command = [...resolved.argv];
    if (quoteUrl) {
        if (command.at(-1) === "") {
            // Preserve the empty title token for `start` when using verbatim args.
            command[command.length - 1] = '""';
        }
        command.push(`"${url}"`);
    }
    else {
        command.push(url);
    }
    try {
        await runCommandWithTimeout(command, {
            timeoutMs: 5_000,
            windowsVerbatimArguments: quoteUrl,
        });
        return true;
    }
    catch {
        // ignore; we still print the URL for manual open
        return false;
    }
}
export async function openUrlInBackground(url) {
    if (shouldSkipBrowserOpenInTests()) {
        return false;
    }
    if (process.platform !== "darwin") {
        return false;
    }
    const resolved = await resolveBrowserOpenCommand();
    if (!resolved.argv || resolved.command !== "open") {
        return false;
    }
    const command = ["open", "-g", url];
    try {
        await runCommandWithTimeout(command, { timeoutMs: 5_000 });
    }
    finally {
    }
}
