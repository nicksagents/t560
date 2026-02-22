import { App } from "@slack/bolt";
import { loadSession, saveSession } from "../gateway/state.js";
import { runAgentTurn } from "../gateway/agent.js";
import { parseModelRef } from "../models/model_ref.js";
import { ensureFreshOpenAICodexOAuth } from "../auth/openai_codex_oauth.js";
import { buildIdentityInstructions } from "../workspace/identity.js";
import { handleChatCommand } from "../gateway/chat_commands.js";
import { resolveModelRefForTurn } from "../gateway/model_select.js";

function parseAllowlist(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  return s
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function isAllowed(allow, userId) {
  if (!userId) return false;
  if (!Array.isArray(allow) || allow.length === 0) return false;
  return allow.includes(userId);
}

function stripSlackBotMention(text, botUserId) {
  const t = String(text ?? "");
  if (!botUserId) return t.trim();
  // Typical mention format: "<@U123ABC>"
  return t.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
}

export function startSlackBot(params) {
  const { env, config, secrets, log = console.log } = params;

  const botToken = String(secrets.SLACK_BOT_TOKEN ?? "").trim();
  const appToken = String(secrets.SLACK_APP_TOKEN ?? "").trim();
  if (!botToken || !appToken) {
    throw new Error("Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN.");
  }

  const allow = parseAllowlist(config?.channels?.slack?.allowFrom);
  const openaiApiKey = String(secrets.OPENAI_API_KEY ?? "").trim();
  const anthropicApiKey = String(secrets.ANTHROPIC_API_KEY ?? "").trim();
  const deepseekApiKey = String(secrets.DEEPSEEK_API_KEY ?? "").trim();
  const openrouterApiKey = String(secrets.OPENROUTER_API_KEY ?? "").trim();
  const xaiApiKey = String(secrets.XAI_API_KEY ?? "").trim();
  const togetherApiKey = String(secrets.TOGETHER_API_KEY ?? "").trim();
  const veniceApiKey = String(secrets.VENICE_API_KEY ?? "").trim();
  const moonshotApiKey = String(secrets.MOONSHOT_API_KEY ?? "").trim();
  const minimaxApiKey = String(secrets.MINIMAX_API_KEY ?? "").trim();
  const xiaomiApiKey = String(secrets.XIAOMI_API_KEY ?? "").trim();
  const syntheticApiKey = String(secrets.SYNTHETIC_API_KEY ?? "").trim();
  const cloudflareApiKey = String(secrets.CLOUDFLARE_AI_GATEWAY_API_KEY ?? "").trim();
  const cloudflareAccountId = String(config?.providers?.cloudflareAiGateway?.accountId ?? "").trim();
  const cloudflareGatewayId = String(config?.providers?.cloudflareAiGateway?.gatewayId ?? "").trim();
  const identity = buildIdentityInstructions({ workspaceDir: config?.workspaceDir });

  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });

  let botUserId = "";
  app.event("app_home_opened", async () => {
    // Lazy populate bot ID.
    if (botUserId) return;
    try {
      const auth = await app.client.auth.test({ token: botToken });
      botUserId = String(auth?.user_id ?? "").trim();
    } catch {
      // ignore
    }
  });

  const handleText = async ({ user, channel, text, say, threadTs }) => {
    if (!user || !channel) return;
    if (allow.length > 0 && !isAllowed(allow, user)) {
      await say("t560: you are not on the allowlist for this bot.");
      return;
    }

    const cleaned = stripSlackBotMention(text, botUserId);
    if (!cleaned) return;

    const sessionId = `slack_${channel}_${user}`;
    const snap = loadSession(sessionId, env);
    let session = snap.session;

    const cmdHandled = handleChatCommand({ cfg: config, session, message: cleaned });
    if (cmdHandled) {
      session = cmdHandled.session;
      saveSession(sessionId, session, env);
      await say(cmdHandled.reply);
      return;
    }

    const sel = resolveModelRefForTurn({ cfg: config, session, message: cleaned });
    session = sel.session;
    const modelRef = sel.modelRef;
    session = {
      ...session,
      meta: { ...(session?.meta && typeof session.meta === "object" ? session.meta : {}), lastModelRef: modelRef },
    };

    let messages = Array.isArray(session.messages) ? session.messages : [];
    messages = [...messages, { role: "user", content: cleaned }];
    session = { ...session, messages };

    const parsed = parseModelRef(modelRef);
    const wantsCodex = parsed.provider === "openai-codex";
    let codex = null;
    if (wantsCodex) {
      const { creds } = await ensureFreshOpenAICodexOAuth(env);
      codex = { accessToken: String(creds.access ?? "").trim(), accountId: String(creds.accountId ?? "").trim() };
    }
    if (parsed.provider === "openai" && !openaiApiKey) {
      await say("t560 error: OPENAI_API_KEY is not configured. Run: t560 deploy");
      return;
    }
    if (parsed.provider === "deepseek" && !deepseekApiKey) {
      await say("t560 error: DEEPSEEK_API_KEY is not configured. Run: t560 deploy");
      return;
    }
    if (parsed.provider === "anthropic" && !anthropicApiKey) {
      await say("t560 error: ANTHROPIC_API_KEY is not configured. Run: t560 deploy");
      return;
    }
    if (parsed.provider === "openrouter" && !openrouterApiKey) {
      await say("t560 error: OPENROUTER_API_KEY is not configured. Run: t560 deploy");
      return;
    }
    if (parsed.provider === "xai" && !xaiApiKey) {
      await say("t560 error: XAI_API_KEY is not configured. Run: t560 deploy");
      return;
    }
    if (parsed.provider === "together" && !togetherApiKey) {
      await say("t560 error: TOGETHER_API_KEY is not configured. Run: t560 deploy");
      return;
    }
    if (parsed.provider === "venice" && !veniceApiKey) {
      await say("t560 error: VENICE_API_KEY is not configured. Run: t560 deploy");
      return;
    }
    if (parsed.provider === "moonshot" && !moonshotApiKey) {
      await say("t560 error: MOONSHOT_API_KEY is not configured. Run: t560 deploy");
      return;
    }
    if (parsed.provider === "minimax" && !minimaxApiKey) {
      await say("t560 error: MINIMAX_API_KEY is not configured. Run: t560 deploy");
      return;
    }
    if (parsed.provider === "xiaomi" && !xiaomiApiKey) {
      await say("t560 error: XIAOMI_API_KEY is not configured. Run: t560 deploy");
      return;
    }
    if (parsed.provider === "synthetic" && !syntheticApiKey) {
      await say("t560 error: SYNTHETIC_API_KEY is not configured. Run: t560 deploy");
      return;
    }
    if (parsed.provider === "cloudflare-ai-gateway") {
      if (!cloudflareApiKey) {
        await say("t560 error: CLOUDFLARE_AI_GATEWAY_API_KEY is not configured. Run: t560 deploy");
        return;
      }
      if (!cloudflareAccountId || !cloudflareGatewayId) {
        await say("t560 error: Cloudflare AI Gateway accountId/gatewayId missing in config. Run: t560 deploy");
        return;
      }
    }

    try {
      const turn = await runAgentTurn({
        env,
        sessionId,
        cfg: config,
        identity,
        auth: {
          openai: { apiKey: openaiApiKey, organization: config?.openai?.organization, project: config?.openai?.project },
          codex,
          anthropic: { apiKey: anthropicApiKey },
          deepseek: { apiKey: deepseekApiKey },
          openrouter: { apiKey: openrouterApiKey },
          xai: { apiKey: xaiApiKey },
          together: { apiKey: togetherApiKey },
          venice: { apiKey: veniceApiKey },
          moonshot: { apiKey: moonshotApiKey },
          minimax: { apiKey: minimaxApiKey },
          xiaomi: { apiKey: xiaomiApiKey },
          synthetic: { apiKey: syntheticApiKey },
          "cloudflare-ai-gateway": { apiKey: cloudflareApiKey, accountId: cloudflareAccountId, gatewayId: cloudflareGatewayId },
        },
        modelRef,
        enableEmailTools: Boolean(config?.email?.enabled && config?.email?.allowAgentSend),
        enableGitHubTools: Boolean(config?.github?.enabled && config?.github?.allowAgentWrite),
        enableWebTools: Boolean(config?.tools?.web?.search?.enabled || config?.tools?.web?.fetch?.enabled),
        enableTerminalTools: Boolean(config?.tools?.terminal?.enabled && config?.tools?.terminal?.allowAgentExec),
        messageBridge: {
          channel: "slack",
          sendText: async ({ text: outText, target, threadId, action }) => {
            const resolvedChannel = String(target ?? "").trim() || channel;
            const requestedThread = String(threadId ?? "").trim();
            const fallbackThread =
              action === "reply" || action === "thread-reply" ? String(threadTs ?? "").trim() : "";
            const resolvedThread = requestedThread || fallbackThread;
            const sent = await app.client.chat.postMessage({
              token: botToken,
              channel: resolvedChannel,
              text: String(outText ?? ""),
              ...(resolvedThread ? { thread_ts: resolvedThread } : {}),
            });
            return {
              id: String(sent?.ts ?? ""),
              target: resolvedChannel,
              threadId: resolvedThread,
            };
          },
        },
        workspaceDir: config?.workspaceDir,
        messages,
      });
      const out = turn.reply || "(empty response)";
      messages = [...messages, { role: "assistant", content: out }];
      session = { ...session, messages };
      saveSession(sessionId, session, env);
      await say(out);
    } catch (e) {
      await say(`t560 error: ${String(e?.message ?? e)}`);
    }
  };

  app.event("app_mention", async ({ event, say }) => {
    const user = String(event?.user ?? "").trim();
    const channel = String(event?.channel ?? "").trim();
    const text = String(event?.text ?? "");
    const threadTs = String(event?.thread_ts ?? "").trim();
    await handleText({ user, channel, text, say, threadTs });
  });

  // DMs: message.im
  app.event("message", async ({ event, say }) => {
    const subtype = String(event?.subtype ?? "").trim();
    if (subtype) return;
    if (event?.channel_type !== "im") return;
    const user = String(event?.user ?? "").trim();
    const channel = String(event?.channel ?? "").trim();
    const text = String(event?.text ?? "");
    const threadTs = String(event?.thread_ts ?? "").trim();
    await handleText({ user, channel, text, say, threadTs });
  });

  app.error(async (err) => {
    log(`[t560] slack error: ${String(err?.message ?? err)}`);
  });

  void app.start();
  log("[t560] slack bot started (socket mode)");
  return app;
}
