import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { WizardCancelledError } from "./prompter.js";
import { resolveStateDir } from "../config/paths.js";
import { loadConfig, loadSecrets, redactConfigSummary, resetState, saveConfig, saveSecrets } from "../config/store.js";
import { listModels } from "../openai/responses.js";
import { listCompatModels } from "../openai/compat_models.js";
import { saveClient } from "../config/store.js";
import { loadOpenAICodexOAuth, loginOpenAICodexOAuth } from "../auth/openai_codex_oauth.js";
import { startGateway } from "../gateway/server.js";
import { runTerminalChat } from "../terminal/chat_client.js";
import { ensureWorkspaceBootstrap } from "../workspace/bootstrap.js";

function nonEmpty(value) {
  const v = String(value ?? "").trim();
  return v.length > 0 ? v : "";
}

function validateOpenAiKey(value) {
  const v = nonEmpty(value);
  if (!v) return "Required.";
  if (v.length < 20) return "That looks too short for an API key.";
  return undefined;
}

function validateAnthropicKey(value) {
  const v = nonEmpty(value);
  if (!v) return "Required.";
  if (v.length < 20) return "That looks too short for a token/key.";
  return undefined;
}

function validateGenericKey(value) {
  const v = nonEmpty(value);
  if (!v) return "Required.";
  if (v.length < 10) return "That looks too short.";
  return undefined;
}

function buildSlackManifest(appName) {
  const safeName = String(appName ?? "").trim() || "t560";
  const manifest = {
    display_information: {
      name: safeName,
      description: `${safeName} connector for t560`,
    },
    features: {
      bot_user: {
        display_name: safeName,
        always_online: false,
      },
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      slash_commands: [
        {
          command: "/t560",
          description: "Send a message to t560",
          should_escape: false,
        },
      ],
    },
    oauth_config: {
      scopes: {
        bot: [
          "chat:write",
          "channels:history",
          "channels:read",
          "groups:history",
          "im:history",
          "mpim:history",
          "users:read",
          "app_mentions:read",
          "reactions:read",
          "reactions:write",
          "pins:read",
          "pins:write",
          "emoji:read",
          "commands",
          "files:read",
          "files:write",
        ],
      },
    },
    settings: {
      socket_mode_enabled: true,
      event_subscriptions: {
        bot_events: ["app_mention", "message.im"],
      },
    },
  };
  return JSON.stringify(manifest, null, 2);
}

function writeUtf8(filePath, content) {
  fs.writeFileSync(filePath, String(content ?? ""), "utf8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
}

function resolveEditor() {
  const visual = nonEmpty(process.env.VISUAL);
  if (visual) return visual;
  const editor = nonEmpty(process.env.EDITOR);
  if (editor) return editor;
  if (process.platform === "win32") return "notepad";
  return "nano";
}

function openInEditor(filePath) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { ok: false, reason: "no-tty" };
  }
  const editor = resolveEditor();
  const escapedPath = String(filePath).replace(/(["\\$`])/g, "\\$1");
  const cmd = `${editor} "${escapedPath}"`;
  const out = spawnSync(cmd, {
    shell: true,
    stdio: "inherit",
  });
  if (out.error) return { ok: false, reason: String(out.error?.message ?? out.error) };
  if (typeof out.status === "number" && out.status !== 0) return { ok: false, reason: `exit ${out.status}` };
  return { ok: true };
}

function buildUserMarkdown(profile) {
  const p = profile ?? {};
  const section = (title, lines) => {
    const kept = lines.filter((v) => nonEmpty(v));
    if (kept.length === 0) return "";
    return [`## ${title}`, ...kept].join("\n");
  };

  const blocks = [
    "# USER.md",
    "",
    section("Identity", [
      `- Name: ${nonEmpty(p.name) || "(not set)"}`,
      `- Preferred address: ${nonEmpty(p.preferredAddress) || "(not set)"}`,
      `- Role/context: ${nonEmpty(p.roleContext) || "(not set)"}`,
      `- Timezone/location: ${nonEmpty(p.timezone) || "(not set)"}`,
    ]),
    "",
    section("Goals", [`- Primary goals for t560: ${nonEmpty(p.goals) || "(not set)"}`]),
    "",
    section("Communication Preferences", [
      `- Style: ${nonEmpty(p.style) || "(not set)"}`,
      `- Response format: ${nonEmpty(p.responseFormat) || "(not set)"}`,
      `- Constraints / do-not: ${nonEmpty(p.constraints) || "(not set)"}`,
    ]),
    "",
    section("Workflow", [
      `- Preferred channels/tools: ${nonEmpty(p.channels) || "(not set)"}`,
      `- Projects/repos: ${nonEmpty(p.projects) || "(not set)"}`,
    ]),
    "",
    section("Additional Notes", [`- ${nonEmpty(p.notes) || "(none)"}`]),
    "",
  ].filter(Boolean);

  return blocks.join("\n");
}

export async function runOnboardingWizard({ prompter, env = process.env } = {}) {
  await prompter.intro("Deploy t560");

  await prompter.note(
    [
      "Security warning",
      "",
      "t560 can be configured to read files and run commands on your machine.",
      "If you enable powerful tools, treat prompts as untrusted input.",
      "",
      "Recommended baseline:",
      "- Keep your API key private.",
      "- Use a workspace directory with minimal sensitive data.",
      "- Review tool permissions before enabling anything destructive.",
      "",
      "Run regularly:",
      "t560 security audit",
    ].join("\n"),
    "Security",
  );

  const ok = await prompter.confirm({
    message: "I understand this is powerful and inherently risky. Continue?",
    initialValue: false,
  });
  if (!ok) throw new WizardCancelledError("risk not accepted");

  const snapshot = loadConfig(env);
  let baseConfig = snapshot.config ?? {};
  let existingSecrets = loadSecrets(env).secrets ?? {};

  if (snapshot.exists) {
    if (snapshot.error) {
      await prompter.note(
        [
          "Your config file exists but could not be read.",
          "t560 will continue with a fresh config.",
          "",
          `Error: ${snapshot.error?.message ?? String(snapshot.error)}`,
        ].join("\n"),
        "Config",
      );
      baseConfig = {};
    } else {
      await prompter.note(redactConfigSummary(baseConfig), "Existing config detected");
      const action = await prompter.select({
        message: "Config handling",
        options: [
          { value: "keep", label: "Use existing values" },
          { value: "modify", label: "Update values" },
          { value: "reset", label: "Reset (config + secrets)" },
        ],
      });
      if (action === "reset") {
        resetState(env);
        baseConfig = {};
        existingSecrets = {};
      }
    }
  }

  const stateDir = resolveStateDir(env);
  const defaultWorkspace = baseConfig.workspaceDir ? String(baseConfig.workspaceDir) : path.join(stateDir, "workspace");

  const flow = await prompter.select({
    message: "Deploy mode",
    options: [
      {
        value: "quickstart",
        label: "QuickStart",
        hint: "API key + default model + workspace (you can edit later)",
      },
      {
        value: "manual",
        label: "Manual",
        hint: "Set optional OpenAI org/project and other advanced values",
      },
    ],
    initialValue: "quickstart",
  });

  const workspaceDir =
    flow === "quickstart"
      ? defaultWorkspace
      : await prompter.text({
          message: "Workspace directory",
          initialValue: defaultWorkspace,
          validate: (v) => (!nonEmpty(v) ? "Required." : undefined),
        });

  // --- Gateway (WebChat) ---
  const gatewayPortRaw =
    flow === "quickstart"
      ? String(baseConfig?.gateway?.port ?? 18789)
      : await prompter.text({
          message: "Gateway port",
          initialValue: String(baseConfig?.gateway?.port ?? 18789),
          validate: (v) => {
            const n = Number.parseInt(String(v ?? ""), 10);
            if (!Number.isFinite(n) || n <= 0 || n > 65535) return "Enter a valid port (1-65535).";
            return undefined;
          },
        });
  const gatewayPort = Number.parseInt(String(gatewayPortRaw), 10);

  const bindChoice =
    flow === "quickstart"
      ? (baseConfig?.gateway?.bind ?? "loopback")
      : await prompter.select({
          message: "Gateway bind",
          options: [
            {
              value: "loopback",
              label: "Loopback (127.0.0.1)",
              hint: "local machine only (recommended)",
            },
            { value: "lan", label: "LAN (0.0.0.0)", hint: "reachable on your network (be careful)" },
          ],
          initialValue: baseConfig?.gateway?.bind ?? "loopback",
        });

  const authMode =
    flow === "quickstart"
      ? (baseConfig?.gateway?.auth?.mode ?? "token")
      : await prompter.select({
          message: "Gateway auth",
          options: [
            { value: "token", label: "Token (default)", hint: "best for local and scripts" },
            { value: "password", label: "Password", hint: "easy to type, weaker than a long token" },
          ],
          initialValue: baseConfig?.gateway?.auth?.mode ?? "token",
        });

  await prompter.note(
    [
      "Model setup",
      "",
      "t560 is OpenAI-first by default.",
      "Credentials are stored locally under your t560 state dir with restrictive permissions.",
    ].join("\n"),
    "Models",
  );

  const configured = new Set();
  const selectedProviders = new Set();

  let openAiKey = "";
  // Back-compat: old configs may use "api_key" or "codex_oauth".
  const openAiAuthRaw = String(baseConfig?.openai?.auth?.method ?? "openai-api-key");
  let openAiAuthMethod =
    openAiAuthRaw === "codex_oauth" || openAiAuthRaw === "openai-codex"
      ? "openai-codex"
      : openAiAuthRaw === "api_key" || openAiAuthRaw === "openai-api-key"
