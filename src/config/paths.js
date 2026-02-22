import os from "node:os";
import path from "node:path";

function expandTilde(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return raw;
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

export function resolveStateDir(env = process.env) {
  const raw = env.T560_STATE_DIR?.trim() || "~/.t560";
  return path.resolve(expandTilde(raw));
}

export function resolveConfigPath(env = process.env) {
  const stateDir = resolveStateDir(env);
  return path.join(stateDir, "config.json");
}

export function resolveSecretsPath(env = process.env) {
  const stateDir = resolveStateDir(env);
  return path.join(stateDir, "secrets.env");
}

export function resolveClientPath(env = process.env) {
  const stateDir = resolveStateDir(env);
  return path.join(stateDir, "client.json");
}

export function resolveOAuthDir(env = process.env) {
  const stateDir = resolveStateDir(env);
  return path.join(stateDir, "oauth");
}

export function resolveOpenAICodexOAuthPath(env = process.env) {
  const oauthDir = resolveOAuthDir(env);
  return path.join(oauthDir, "openai-codex.json");
}
