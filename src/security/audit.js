import fs from "node:fs";
import path from "node:path";
import { resolveStateDir, resolveSecretsPath, resolveConfigPath } from "../config/paths.js";
import { loadConfig, loadSecrets } from "../config/store.js";

function tryStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function modeOct(stat) {
  if (!stat) return null;
  return stat.mode & 0o777;
}

function fmtPerm(oct) {
  if (oct === null || oct === undefined) return "(unknown)";
  return `0${oct.toString(8)}`.slice(-4);
}

function issue(sev, title, details, fix) {
  return {
    severity: sev, // "info" | "warn" | "danger"
    title,
    details: String(details ?? "").trim(),
    fix: String(fix ?? "").trim(),
  };
}

export function auditSecurity(env = process.env) {
  const findings = [];

  const cfgSnap = loadConfig(env);
  const secretsSnap = loadSecrets(env);
  const cfg = cfgSnap?.config ?? {};
  const secrets = secretsSnap?.secrets ?? {};

  const stateDir = resolveStateDir(env);
  const stateStat = tryStat(stateDir);
  if (!stateStat) {
    findings.push(
      issue(
        "warn",
        "State directory missing",
        `State dir does not exist: ${stateDir}`,
        "Run: t560 onboard (it will create the state dir).",
      ),
    );
  } else {
    const perm = modeOct(stateStat);
    if (perm !== null && perm !== 0o700) {
      findings.push(
        issue(
          "warn",
          "State directory permissions",
          `State dir permissions are ${fmtPerm(perm)} (recommended: 0700): ${stateDir}`,
          `Run: chmod 700 "${stateDir}"`,
        ),
      );
    }
  }

  const secretsPath = resolveSecretsPath(env);
  const secretsStat = tryStat(secretsPath);
  if (!secretsStat) {
    findings.push(
      issue(
        "warn",
        "Secrets file missing",
        `Secrets file does not exist: ${secretsPath}`,
        "Run: t560 onboard (it will create secrets.env).",
      ),
    );
  } else {
    const perm = modeOct(secretsStat);
    if (perm !== null && perm !== 0o600) {
      findings.push(
        issue(
          "danger",
          "Secrets file permissions",
          `Secrets file permissions are ${fmtPerm(perm)} (recommended: 0600): ${secretsPath}`,
          `Run: chmod 600 "${secretsPath}"`,
        ),
      );
    }
  }

  const cfgPath = resolveConfigPath(env);
  const cfgStat = tryStat(cfgPath);
  if (cfgStat) {
    const perm = modeOct(cfgStat);
    if (perm !== null && perm !== 0o600) {
      findings.push(
        issue(
          "warn",
          "Config file permissions",
          `Config file permissions are ${fmtPerm(perm)} (recommended: 0600): ${cfgPath}`,
          `Run: chmod 600 "${cfgPath}"`,
        ),
      );
    }
  }

  const bind = String(cfg?.gateway?.bind ?? "loopback").trim();
  const authMode = String(cfg?.gateway?.auth?.mode ?? "token").trim();
  const gwExposed = bind === "lan";
  const hasAuth =
    authMode === "password"
      ? Boolean(String(secrets.T560_GATEWAY_PASSWORD ?? "").trim())
      : Boolean(String(secrets.T560_GATEWAY_TOKEN ?? "").trim());

  if (gwExposed && !hasAuth) {
    findings.push(
      issue(
        "danger",
        "Gateway is reachable on LAN without auth",
        "Gateway bind is LAN (0.0.0.0) but token/password is missing. Anyone on your network could access the control UI and chat.",
        "Run: t560 onboard and set gateway auth, or change gateway bind to loopback.",
      ),
    );
  } else if (gwExposed) {
    findings.push(
      issue(
        "info",
        "Gateway reachable on LAN",
        `Gateway bind is LAN and auth mode is ${authMode}.`,
        "Recommended: keep bind=loopback unless you need LAN access.",
      ),
    );
  }

  const webSearchEnabled = Boolean(cfg?.tools?.web?.search?.enabled);
  const webFetchEnabled = Boolean(cfg?.tools?.web?.fetch?.enabled);
  if (webSearchEnabled && !String(secrets.BRAVE_API_KEY ?? "").trim()) {
    findings.push(
      issue(
        "warn",
        "Web search enabled but BRAVE_API_KEY missing",
        "Wizard enabled web search but the Brave Search API key is not set in secrets.",
        "Run: t560 onboard and set BRAVE_API_KEY, or disable web search.",
      ),
    );
  }

  const tgEnabled = Boolean(cfg?.channels?.telegram?.enabled);
  if (tgEnabled) {
    const dmPolicy = String(cfg?.channels?.telegram?.dmPolicy ?? "pairing").trim();
    const allowFrom = String(cfg?.channels?.telegram?.allowFrom ?? "").trim();
    if (!String(secrets.TELEGRAM_BOT_TOKEN ?? "").trim() && !String(env.TELEGRAM_BOT_TOKEN ?? "").trim()) {
      findings.push(
        issue(
          "warn",
          "Telegram enabled but TELEGRAM_BOT_TOKEN missing",
          "Telegram channel is enabled but the bot token is not configured.",
          "Run: t560 onboard and set TELEGRAM_BOT_TOKEN.",
        ),
      );
    }
    if (dmPolicy === "open" || allowFrom === "*") {
      findings.push(
        issue(
          "danger",
          "Telegram DMs are open",
          "Telegram is configured to accept messages from anyone. This is risky if tools are enabled.",
          "Recommended: set dmPolicy=pairing (default) or dmPolicy=allowlist.",
        ),
      );
    } else if (dmPolicy === "pairing") {
      findings.push(
        issue(
          "info",
          "Telegram pairing enabled",
          "Unknown DM senders will receive a pairing code and must be approved.",
          "Approve with: t560 pairing approve telegram <code> --notify",
        ),
      );
    }
  }

  if (webSearchEnabled || webFetchEnabled) {
    findings.push(
      issue(
        "info",
        "Web tools enabled",
        "t560 can fetch and/or search the web. Treat prompts as untrusted and keep gateway exposure tight.",
        "If you don't need it, disable web tools in onboarding.",
      ),
    );
  }

  if (findings.length === 0) {
    findings.push(issue("info", "No findings", "No obvious issues detected.", ""));
  }

  return { ok: true, findings };
}

