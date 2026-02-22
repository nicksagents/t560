import { Bot } from "grammy";
import { loadSession, saveSession } from "../gateway/state.js";
import { runAgentTurn } from "../gateway/agent.js";
import { parseModelRef } from "../models/model_ref.js";
import { ensureFreshOpenAICodexOAuth } from "../auth/openai_codex_oauth.js";
import { buildIdentityInstructions } from "../workspace/identity.js";
import { buildPairingReply } from "../pairing/messages.js";
import { readAllowFromStore, upsertPairingRequest } from "../pairing/store.js";
import { handleChatCommand } from "../gateway/chat_commands.js";
import { resolveModelRefForTurn } from "../gateway/model_select.js";

function parseAllowFrom(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { open: false, ids: [] };
  const parts = s
    .split(/[\n,;]+/g)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  const open = parts.some((p) => p === "*" || p.toLowerCase() === "all");
  const ids = parts
    .map((p) => Number.parseInt(p, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return { open, ids };
}

function parseAllowUsernames(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  return s
    .split(/[\n,;]+/g)
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => v.replace(/^(telegram|tg):/i, "").trim())
    .filter((v) => v.startsWith("@"))
    .map((v) => v.toLowerCase());
}

export function startTelegramBot(params) {
  const { token, allowFrom, env, config, secrets, log = console.log } = params;

  const dmPolicy = String(config?.channels?.telegram?.dmPolicy ?? "pairing").trim();
  const allow = parseAllowFrom(allowFrom);
  const allowUsernames = parseAllowUsernames(allowFrom);
  const bot = new Bot(String(token));
  let botUsername = "";

  // Best-effort: used for mention gating in groups.
  void bot.api
    .getMe()
    .then((me) => {
      botUsername = String(me?.username ?? "").trim();
    })
    .catch(() => {});

  bot.on("message:text", async (ctx) => {
    const fromId = ctx.from?.id;
    if (!fromId) return;

    const chatType = String(ctx.chat?.type ?? "");
    const isPrivate = chatType === "private";

    // In groups, require an explicit mention or "/t560" prefix. Safe default.
    const rawText = String(ctx.message?.text ?? "");
    if (!rawText.trim()) return;
    let text = rawText.trim();
    if (!isPrivate) {
      const mention = botUsername ? new RegExp(`@${botUsername}\\b`, "i") : null;
      const hasMention = mention ? mention.test(text) : false;
      const hasCmd = text.toLowerCase().startsWith("/t560");
      if (!hasMention && !hasCmd) return;
      if (mention) text = text.replace(mention, "").trim();
      if (hasCmd) text = text.replace(/^\/t560\b/i, "").trim();
      if (!text) return;
    }

    // Explicit pairing command: always available in DMs when pairing is enabled.
    if (isPrivate) {
      const normalizedCmd = text.toLowerCase();
      const isPairCmd = /^\/pair(@[a-z0-9_]+)?$/i.test(text);
      if (isPairCmd && dmPolicy === "pairing") {
        const username = ctx.from?.username ? `@${String(ctx.from.username)}`.toLowerCase() : "";
        const meta = {
          username: username || "",
          name: String([ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ")).trim(),
        };
        const { code } = upsertPairingRequest({ channel: "telegram", id: String(fromId), meta, env });
        const reply = buildPairingReply({
          channel: "telegram",
          idLine: `telegram user id: ${fromId}${username ? ` (${username})` : ""}`,
          code,
        });
        // Send the setup code as a separate message for easy copy/paste.
        await ctx.reply(String(code));
        await ctx.reply(reply);
        return;
      }

      // /start is a common first message; treat it like a normal DM for access control.
      if (normalizedCmd === "/start") {
        text = "";
      }
    }

    // DM access control: pairing (default) / allowlist / open / disabled
    if (isPrivate && dmPolicy === "disabled") return;
    const isOpen = (isPrivate && (dmPolicy === "open" || allow.open)) || (!isPrivate && allow.open);
    if (!isOpen) {
      const storeAllow = readAllowFromStore("telegram", env);
      const username = ctx.from?.username ? `@${String(ctx.from.username)}`.toLowerCase() : "";
      const allowedByConfig = allow.ids.includes(fromId) || (username && allowUsernames.includes(username));
      const allowedByStore = storeAllow.includes(String(fromId)) || (username && storeAllow.includes(username));
      const allowed = allowedByConfig || allowedByStore;
      if (!allowed) {
        if (isPrivate && dmPolicy === "pairing") {
          const meta = {
            username: username || "",
            name: String([ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ")).trim(),
          };
          const { code } = upsertPairingRequest({ channel: "telegram", id: String(fromId), meta, env });
          const reply = buildPairingReply({
            channel: "telegram",
            idLine: `telegram user id: ${fromId}${username ? ` (${username})` : ""}`,
            code,
          });
          await ctx.reply(String(code));
          await ctx.reply(reply);
          return;
        }
        await ctx.reply("t560: you are not on the allowlist for this bot.");
        return;
      }
    }

    if (!text) return;

    const sessionId = isPrivate ? `telegram_${fromId}` : `telegram_group_${String(ctx.chat?.id ?? "0")}`;
    const identity = buildIdentityInstructions({ workspaceDir: config?.workspaceDir });
    const snap = loadSession(sessionId, env);
    let session = snap.session;

    const cmdHandled = handleChatCommand({ cfg: config, session, message: text });
    if (cmdHandled) {
      session = cmdHandled.session;
      saveSession(sessionId, session, env);
      await ctx.reply(cmdHandled.reply);
      return;
    }

    const sel = resolveModelRefForTurn({ cfg: config, session, message: text });
    session = sel.session;
    const modelRef = sel.modelRef;
    session = {
      ...session,
      meta: { ...(session?.meta && typeof session.meta === "object" ? session.meta : {}), lastModelRef: modelRef },
    };

    let messages = Array.isArray(session.messages) ? session.messages : [];
    messages = [...messages, { role: "user", content: text }];
    session = { ...session, messages };

    try {
      const parsed = parseModelRef(modelRef);
      const wantsCodex = parsed.provider === "openai-codex";
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
      let codex = null;
      if (wantsCodex) {
        const { creds } = await ensureFreshOpenAICodexOAuth(env);
        codex = { accessToken: String(creds.access ?? "").trim(), accountId: String(creds.accountId ?? "").trim() };
      }
      if (parsed.provider === "openai" && !openaiApiKey) {
        throw new Error("OPENAI_API_KEY is not configured. Run: t560 deploy");
      }
      if (parsed.provider === "deepseek" && !deepseekApiKey) {
        throw new Error("DEEPSEEK_API_KEY is not configured. Run: t560 deploy");
      }
      if (parsed.provider === "anthropic" && !anthropicApiKey) {
        throw new Error("ANTHROPIC_API_KEY is not configured. Run: t560 deploy");
      }
      if (parsed.provider === "openrouter" && !openrouterApiKey) {
        throw new Error("OPENROUTER_API_KEY is not configured. Run: t560 deploy");
      }
      if (parsed.provider === "xai" && !xaiApiKey) {
        throw new Error("XAI_API_KEY is not configured. Run: t560 deploy");
      }
      if (parsed.provider === "together" && !togetherApiKey) {
        throw new Error("TOGETHER_API_KEY is not configured. Run: t560 deploy");
      }
      if (parsed.provider === "venice" && !veniceApiKey) {
        throw new Error("VENICE_API_KEY is not configured. Run: t560 deploy");
      }
      if (parsed.provider === "moonshot" && !moonshotApiKey) {
        throw new Error("MOONSHOT_API_KEY is not configured. Run: t560 deploy");
      }
      if (parsed.provider === "minimax" && !minimaxApiKey) {
        throw new Error("MINIMAX_API_KEY is not configured. Run: t560 deploy");
      }
      if (parsed.provider === "xiaomi" && !xiaomiApiKey) {
        throw new Error("XIAOMI_API_KEY is not configured. Run: t560 deploy");
      }
      if (parsed.provider === "synthetic" && !syntheticApiKey) {
        throw new Error("SYNTHETIC_API_KEY is not configured. Run: t560 deploy");
      }
      if (parsed.provider === "cloudflare-ai-gateway") {
        if (!cloudflareApiKey) throw new Error("CLOUDFLARE_AI_GATEWAY_API_KEY is not configured. Run: t560 deploy");
        if (!cloudflareAccountId || !cloudflareGatewayId) {
          throw new Error("Cloudflare AI Gateway accountId/gatewayId missing in config. Run: t560 deploy");
        }
      }
      const turn = await runAgentTurn({
        sessionId,
        cfg: config,
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
        env,
        identity,
        enableEmailTools: Boolean(config?.email?.enabled && config?.email?.allowAgentSend),
        enableGitHubTools: Boolean(config?.github?.enabled && config?.github?.allowAgentWrite),
        enableWebTools: Boolean(config?.tools?.web?.search?.enabled || config?.tools?.web?.fetch?.enabled),
        enableTerminalTools: Boolean(config?.tools?.terminal?.enabled && config?.tools?.terminal?.allowAgentExec),
        messageBridge: {
          channel: "telegram",
          sendText: async ({ text: outText, target, threadId }) => {
            const toRaw = String(target ?? "").trim();
            const to = toRaw || String(ctx.chat?.id ?? "");
            const chatId = /^-?\d+$/.test(to) ? Number.parseInt(to, 10) : to;
            const topicRaw = String(threadId ?? "").trim();
            const topicId = /^-?\d+$/.test(topicRaw) ? Number.parseInt(topicRaw, 10) : undefined;
            const sent = await ctx.api.sendMessage(chatId, String(outText ?? ""), {
              ...(Number.isFinite(topicId) ? { message_thread_id: topicId } : {}),
            });
            return {
              id: sent?.message_id ?? null,
              target: String(to),
