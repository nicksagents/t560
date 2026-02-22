import fs from "node:fs";
import { loginOpenAICodex, refreshOpenAICodexToken } from "@mariozechner/pi-ai";
import { resolveOAuthDir, resolveOpenAICodexOAuthPath } from "../config/paths.js";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function chmod600IfPossible(filePath) {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort (e.g. Windows/WSL edge cases)
  }
}

export function loadOpenAICodexOAuth(env = process.env) {
  const p = resolveOpenAICodexOAuthPath(env);
  if (!fs.existsSync(p)) return { exists: false, creds: null };
  try {
    const raw = fs.readFileSync(p, "utf8");
    const creds = JSON.parse(raw);
    return { exists: true, creds };
  } catch (error) {
    return { exists: true, creds: null, error };
  }
}

export function saveOpenAICodexOAuth(creds, env = process.env) {
  const oauthDir = resolveOAuthDir(env);
  ensureDir(oauthDir);
  const p = resolveOpenAICodexOAuthPath(env);
  fs.writeFileSync(p, JSON.stringify(creds, null, 2) + "\n", "utf8");
  chmod600IfPossible(p);
  return p;
}

export function deleteOpenAICodexOAuth(env = process.env) {
  const p = resolveOpenAICodexOAuthPath(env);
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // ignore
  }
  const dir = resolveOAuthDir(env);
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // ignore
  }
}

function needsRefresh(creds, skewMs = 60_000) {
  const exp = Number(creds?.expires ?? 0);
  if (!Number.isFinite(exp) || exp <= 0) return true;
  return Date.now() >= exp - skewMs;
}

export async function ensureFreshOpenAICodexOAuth(env = process.env) {
  const snap = loadOpenAICodexOAuth(env);
  if (!snap.exists || !snap.creds) {
    throw new Error("OpenAI Codex OAuth is not configured. Run: t560 onboard (choose Codex OAuth) or: t560 auth codex-login");
  }
  const creds = snap.creds;
  if (!needsRefresh(creds)) return { creds, updated: false };

  const refreshed = await refreshOpenAICodexToken(String(creds.refresh || "").trim());
  const next = { ...creds, ...refreshed };
  saveOpenAICodexOAuth(next, env);
  return { creds: next, updated: true };
}

function isRemoteLike(env = process.env) {
  return Boolean(
    env.SSH_CONNECTION ||
      env.SSH_TTY ||
      env.CODESPACES ||
      env.GITPOD_WORKSPACE_ID ||
      env.REMOTE_CONTAINERS ||
      env.T560_REMOTE_OAUTH,
  );
}

async function tryOpenBrowser(url) {
  // Best-effort. If it fails, user can still copy/paste the URL.
  try {
    const { spawn } = await import("node:child_process");
    const platform = process.platform;
    if (platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
      return true;
    }
    if (platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
      return true;
    }
    spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

export async function loginOpenAICodexOAuth({ prompter, env = process.env } = {}) {
  const remote = isRemoteLike(env);

  const creds = await loginOpenAICodex({
    onAuth: ({ url, instructions }) => {
      const lines = [
        "OpenAI Codex OAuth (ChatGPT subscription)",
        "",
        remote
          ? "Open this URL in your LOCAL browser (this machine is remote):"
          : "Opening browser for sign-in. If it does not open, copy/paste this URL:",
        url,
        "",
        instructions ? String(instructions) : "After login, the flow should return to the terminal automatically.",
        "",
        "Callback: http://localhost:1455/auth/callback",
      ];
      void prompter?.note?.(lines.join("\n"), "OpenAI Codex OAuth");
      if (!remote) {
        void tryOpenBrowser(url);
      }
    },
    onPrompt: async (prompt) => {
      // Fallback when the callback server can't bind or doesn't complete.
      const message = String(prompt?.message ?? "Paste the redirect URL:");
      const input = await prompter.text({
        message,
        placeholder: "http://localhost:1455/auth/callback?code=...&state=...",
        validate: (v) => (!String(v ?? "").trim() ? "Required." : undefined),
      });
      return String(input ?? "");
    },
    onProgress: (msg) => {
      // Optional; wizard can show a spinner separately.
      void msg;
    },
    originator: "pi",
  });

  const p = saveOpenAICodexOAuth(creds, env);
  return { creds, path: p };
}
