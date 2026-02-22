import fs from "node:fs";
import path from "node:path";
import {
  resolveClientPath,
  resolveConfigPath,
  resolveOAuthDir,
  resolveOpenAICodexOAuthPath,
  resolveSecretsPath,
  resolveStateDir,
} from "./paths.js";

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

export function loadConfig(env = process.env) {
  const cfgPath = resolveConfigPath(env);
  if (!fs.existsSync(cfgPath)) return { exists: false, config: {} };
  try {
    const raw = fs.readFileSync(cfgPath, "utf8");
    return { exists: true, config: JSON.parse(raw) };
  } catch (err) {
    return { exists: true, config: {}, error: err };
  }
}

export function saveConfig(config, env = process.env) {
  const stateDir = resolveStateDir(env);
  ensureDir(stateDir);
  const cfgPath = resolveConfigPath(env);
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  chmod600IfPossible(cfgPath);
  return cfgPath;
}

export function loadSecrets(env = process.env) {
  const p = resolveSecretsPath(env);
  if (!fs.existsSync(p)) return { exists: false, secrets: {} };
  const raw = fs.readFileSync(p, "utf8");
  const secrets = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1).trim();
    secrets[k] = v;
  }
  return { exists: true, secrets };
}

export function loadClient(env = process.env) {
  const p = resolveClientPath(env);
  if (!fs.existsSync(p)) return { exists: false, client: {} };
  try {
    const raw = fs.readFileSync(p, "utf8");
    return { exists: true, client: JSON.parse(raw) };
  } catch (err) {
    return { exists: true, client: {}, error: err };
  }
}

export function saveClient(client, env = process.env) {
  const stateDir = resolveStateDir(env);
  ensureDir(stateDir);
  const p = resolveClientPath(env);
  fs.writeFileSync(p, JSON.stringify(client, null, 2) + "\n", "utf8");
  chmod600IfPossible(p);
  return p;
}

export function saveSecrets(secrets, env = process.env) {
  const stateDir = resolveStateDir(env);
  ensureDir(stateDir);
  const p = resolveSecretsPath(env);

  const lines = ["# t560 secrets (keep this file private)", ""];
  for (const [k, v] of Object.entries(secrets)) {
    if (typeof v !== "string" || v.trim() === "") continue;
    lines.push(`${k}=${v}`);
  }
  lines.push("");

  fs.writeFileSync(p, lines.join("\n"), "utf8");
  chmod600IfPossible(p);
  return p;
}

export function resetState(env = process.env) {
  const stateDir = resolveStateDir(env);
  const cfgPath = resolveConfigPath(env);
  const secretsPath = resolveSecretsPath(env);
  const clientPath = resolveClientPath(env);
  const oauthDir = resolveOAuthDir(env);
  const codexPath = resolveOpenAICodexOAuthPath(env);
  const removed = [];

  for (const p of [cfgPath, secretsPath, clientPath, codexPath]) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        removed.push(p);
      }
    } catch {
      // ignore
    }
  }

  // Remove empty dir tree we created (best-effort).
  try {
    if (fs.existsSync(oauthDir) && fs.readdirSync(oauthDir).length === 0) {
      fs.rmdirSync(oauthDir);
    }
    if (fs.existsSync(stateDir) && fs.readdirSync(stateDir).length === 0) {
      fs.rmdirSync(stateDir);
    }
  } catch {
    // ignore
  }

  return { stateDir, removed };
}

export function redactConfigSummary(config) {
  const workspaceDir = config?.workspaceDir ? String(config.workspaceDir) : "(unset)";
  const model =
    config?.models?.default
      ? String(config.models.default)
      : config?.openai?.defaultModel
        ? String(config.openai.defaultModel)
        : "(unset)";
  const codingModel = config?.models?.coding ? String(config.models.coding) : "(unset)";
  const planningModel = config?.models?.planning ? String(config.models.planning) : "(unset)";
  const authMethod = config?.openai?.auth?.method ? String(config.openai.auth.method) : "(unset)";
  const project = config?.openai?.project ? String(config.openai.project) : "(unset)";
  const org = config?.openai?.organization ? String(config.openai.organization) : "(unset)";
  const gwPort = config?.gateway?.port ? String(config.gateway.port) : "(unset)";
  const gwBind = config?.gateway?.bind ? String(config.gateway.bind) : "(unset)";
  const gwAuth = config?.gateway?.auth?.mode ? String(config.gateway.auth.mode) : "(unset)";
  const tg = config?.channels?.telegram?.enabled ? "enabled" : "disabled";
  const slack = config?.channels?.slack?.enabled ? "enabled" : "disabled";
  const email = config?.email?.enabled ? "enabled" : "disabled";
  const gh = config?.github?.enabled ? "enabled" : "disabled";
  const webSearchProvider = config?.tools?.web?.search?.provider
    ? String(config.tools.web.search.provider)
    : "duckduckgo";
  const webSearchEnabled = config?.tools?.web?.search?.enabled ? "enabled" : "disabled";
  const terminalEnabled = config?.tools?.terminal?.enabled ? "enabled" : "disabled";
  const terminalExec = config?.tools?.terminal?.allowAgentExec ? "agent-exec on" : "agent-exec off";
  const terminalScope = config?.tools?.terminal?.restrictToWorkspace === false ? "workspace unrestricted" : "workspace restricted";
  const terminalAllowAll = config?.tools?.terminal?.allowAllCommands ? "allow-all commands" : "allowlist commands";
  return [
    `Workspace: ${workspaceDir}`,
    `OpenAI auth: ${authMethod}`,
    `Default model: ${model}`,
    `Coding model: ${codingModel}`,
    `Planning model: ${planningModel}`,
    `OpenAI project: ${project}`,
    `OpenAI org: ${org}`,
    `Gateway: ${gwBind}:${gwPort} (auth: ${gwAuth})`,
    `Web search: ${webSearchEnabled} (${webSearchProvider})`,
    `Terminal tool: ${terminalEnabled} (${terminalExec}; ${terminalScope}; ${terminalAllowAll})`,
    `Telegram: ${tg}`,
    `Slack: ${slack}`,
    `Email: ${email}`,
    `GitHub: ${gh}`,
  ].join("\n");
}
