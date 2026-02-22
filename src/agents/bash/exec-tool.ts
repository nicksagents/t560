// @ts-nocheck
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
const DEFAULT_MAX_OUTPUT_CHARS = 200_000;
const MIN_MAX_OUTPUT_CHARS = 1_000;
const MAX_MAX_OUTPUT_CHARS = 2_000_000;
let scriptBinaryAvailable;
function shQuote(value) {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}
function resolveShellArgs(params) {
    const shellBase = path.basename(params.shell).toLowerCase();
    if (shellBase === "pwsh" || shellBase === "powershell") {
        return params.login
            ? ["-Login", "-NoLogo", "-Command", params.command]
            : ["-NoLogo", "-Command", params.command];
    }
    return params.login ? ["-lc", params.command] : ["-c", params.command];
}
function canUseScriptPty() {
    if (process.platform === "win32") {
        return false;
    }
    if (scriptBinaryAvailable !== undefined) {
        return scriptBinaryAvailable;
    }
    const check = spawnSync("sh", ["-lc", "command -v script >/dev/null 2>&1"]);
    scriptBinaryAvailable = check.status === 0;
    return scriptBinaryAvailable;
}
function launchShellProcess(params) {
    const shellArgs = resolveShellArgs({
        shell: params.shell,
        login: params.login,
        command: params.command
    });
    if (!params.pty) {
        return {
            child: spawn(params.shell, shellArgs, {
                cwd: params.cwd,
                env: params.env
            }),
            pty: false
        };
    }
    if (!canUseScriptPty()) {
        if (params.ptyMode === "require") {
            throw new Error("PTY requested but util-linux `script` is unavailable on this host.");
        }
        return {
            child: spawn(params.shell, shellArgs, {
                cwd: params.cwd,
                env: params.env
            }),
            pty: false,
            ptyWarning: "PTY requested but unavailable; command ran without PTY."
        };
    }
    // Use util-linux `script` to allocate a pseudo-terminal while preserving stream output.
    const wrapped = `${shQuote(params.shell)} ${shellArgs.map((arg) => shQuote(arg)).join(" ")}`;
    return {
        child: spawn("script", ["-qefc", wrapped, "/dev/null"], {
            cwd: params.cwd,
            env: params.env
        }),
        pty: true
    };
}
function expandHome(value) {
    const trimmed = value.trim();
    if (trimmed === "~") {
        return os.homedir();
    }
    if (trimmed.startsWith("~/")) {
        return path.join(os.homedir(), trimmed.slice(2));
    }
    return trimmed;
}
function resolveWorkdir(workdir, defaultCwd) {
    const raw = workdir?.trim() ? workdir : defaultCwd;
    const expanded = expandHome(raw);
    if (path.isAbsolute(expanded)) {
        return path.resolve(expanded);
    }
    return path.resolve(defaultCwd, expanded);
}
function assertDirectory(cwd) {
    try {
        const stats = statSync(cwd);
        if (!stats.isDirectory()) {
            throw new Error();
        }
    }
    catch {
        throw new Error(`Working directory does not exist or is not a directory: ${cwd}`);
    }
}
function coerceTimeoutSec(value, fallback) {
    const raw = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(raw)) {
        return Math.max(1, Math.floor(fallback));
    }
    return Math.max(1, Math.floor(raw));
}
function coerceEnv(input) {
    if (!input || typeof input !== "object") {
        return {};
    }
    const entries = Object.entries(input);
    const env = {};
    for (const [key, value] of entries) {
        if (!key.trim()) {
            continue;
        }
        if (value === undefined || value === null) {
            continue;
        }
        env[key] = String(value);
    }
    return env;
}
function summarizeStdio(stdout, stderr) {
    const merged = [stdout, stderr].filter(Boolean).join("");
    const trimmed = merged.trim();
    return trimmed || "(no output)";
}
function pushOutput(state, text, maxChars) {
    if (maxChars <= 0) {
        state.truncated = true;
        return;
    }
    const remaining = maxChars - state.chars;
    if (remaining <= 0) {
        state.truncated = true;
        return;
    }
    if (text.length <= remaining) {
        state.chunks.push(text);
        state.chars += text.length;
        return;
    }
    state.chunks.push(text.slice(0, remaining));
    state.chars += remaining;
    state.truncated = true;
}
async function runForegroundCommand(params) {
    return await new Promise((resolve, reject) => {
        const launched = launchShellProcess({
            shell: params.shell,
            login: params.login,
            command: params.command,
            cwd: params.cwd,
            env: params.env,
            pty: params.pty,
            ptyMode: params.ptyMode
        });
        const child = launched.child;
        const stdoutState = { chunks: [], chars: 0, truncated: false };
        const stderrState = { chunks: [], chars: 0, truncated: false };
        let timedOut = false;
        let forcedKill;
        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            forcedKill = setTimeout(() => {
                child.kill("SIGKILL");
            }, 2000);
            forcedKill.unref?.();
        }, Math.max(1, params.timeoutSec) * 1000);
        timeout.unref?.();
        const onAbort = () => {
            child.kill("SIGTERM");
        };
        params.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", (chunk) => {
            const text = String(chunk);
            pushOutput(stdoutState, text, params.maxOutputChars);
            params.onUpdate?.({ stream: "stdout", chunk: text });
        });
        child.stderr.on("data", (chunk) => {
            const text = String(chunk);
            pushOutput(stderrState, text, params.maxOutputChars);
            params.onUpdate?.({ stream: "stderr", chunk: text });
        });
        child.once("error", (error) => {
            clearTimeout(timeout);
            if (forcedKill)
                clearTimeout(forcedKill);
            params.signal?.removeEventListener("abort", onAbort);
            reject(error);
        });
        child.once("close", (code, signal) => {
            clearTimeout(timeout);
            if (forcedKill)
                clearTimeout(forcedKill);
            params.signal?.removeEventListener("abort", onAbort);
            const status = timedOut
                ? "timeout"
                : signal
                    ? "killed"
                    : code === 0 || code === null
                        ? "completed"
                        : "failed";
            resolve({
                stdout: stdoutState.chunks.join(""),
                stderr: stderrState.chunks.join(""),
                stdoutTruncated: stdoutState.truncated,
                stderrTruncated: stderrState.truncated,
                pty: launched.pty,
                ptyWarning: launched.ptyWarning,
                exitCode: code,
                timedOut,
                status
            });
        });
        const stdinPayload = params.stdin;
        if (typeof stdinPayload === "string" && stdinPayload.length > 0) {
            child.stdin.write(stdinPayload);
            if (params.stdinEof) {
                child.stdin.end();
            }
        }
        else if (params.stdinEof && params.stdin === "") {
            child.stdin.end();
        }
    });
}
function createBackgroundSession(params) {
    return {
        id: params.id,
        scopeKey: params.scopeKey,
        command: params.command,
        cwd: params.cwd,
        shell: params.shell,
        login: params.login,
        pty: params.pty,
        ptyWarning: params.ptyWarning,
        startedAt: Date.now(),
        child: params.child,
        pid: params.child.pid ?? undefined,
        backgrounded: true,
        exited: false,
        status: "running",
        exitCode: null,
        exitSignal: null,
        stdout: [],
        stderr: [],
        stdoutChars: 0,
        stderrChars: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutOffset: 0,
        stderrOffset: 0
    };
}
export function createExecTool(defaults) {
}
