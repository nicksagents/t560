import type { ChatResponse } from "../agent/chat-service.js";
import {
  isAllowedTelegramSender,
  readConfig,
  readOnboardingStatus,
  resolveTelegramBotToken,
  type TelegramDmPolicy
} from "../config/state.js";
import { formatTelegramResponse } from "../format/message-formatter.js";
import type { GatewayInboundMessage } from "../gateway/types.js";
import { isHeartbeatCheckMessage } from "../gateway/heartbeat.js";
import type { AgentEvent } from "../agents/agent-events.js";
import { isPairingApproved, requestPairingCode } from "./pairing.js";
import { clearSessionMessages } from "../provider/session.js";

export type TelegramBridge = {
  enabled: boolean;
  close: () => Promise<void>;
  info: string;
};

export type TelegramBridgeOptions = {
  handleMessage: (input: GatewayInboundMessage) => Promise<ChatResponse>;
  subscribeEvents?: (params: {
    sessionId?: string;
    onEvent: (event: AgentEvent) => void;
  }) => () => void;
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    text?: string;
    from?: {
      id?: number;
    };
    chat?: {
      id?: number;
      type?: string;
    };
  };
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result: T;
};

type TelegramProgressRelay = {
  close: () => Promise<void>;
};

async function callTelegramApi<T>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram API ${method} failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as TelegramApiResponse<T>;
  if (!data.ok) {
    throw new Error(`Telegram API ${method} returned ok=false`);
  }
  return data.result;
}

async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
  parseMode?: "HTML"
): Promise<void> {
  await callTelegramApi(token, "sendMessage", {
    chat_id: chatId,
    text,
    ...(parseMode ? { parse_mode: parseMode } : {})
  });
}

function progressTextFromAgentEvent(event: AgentEvent): string | null {
  if (event.stream === "assistant") {
    const text = event.data.text.trim();
    return text || null;
  }
  return null;
}

function createTelegramProgressRelay(params: {
  token: string;
  chatId: number;
  sessionId: string;
  subscribeEvents?: (params: {
    sessionId?: string;
    onEvent: (event: AgentEvent) => void;
  }) => () => void;
}): TelegramProgressRelay {
  if (!params.subscribeEvents) {
    return {
      close: async () => {}
    };
  }

  const queue: string[] = [];
  const MAX_PROGRESS_MESSAGES = 8;
  const BATCH_LINES = 3;
  let sentCount = 0;
  let lastText = "";
  let lastSentAt = 0;
  let flushTimer: NodeJS.Timeout | null = null;
  let closed = false;
  let sendChain: Promise<void> = Promise.resolve();

  const flush = async (): Promise<void> => {
    if (queue.length === 0 || sentCount >= MAX_PROGRESS_MESSAGES) {
      queue.length = 0;
      return;
    }

    const lines = queue.splice(0, BATCH_LINES);
    if (lines.length === 0) {
      return;
    }

    sentCount += 1;
    const heading = sentCount === 1 ? "Working update:" : "Update:";
    const body = lines.map((line) => `- ${line}`).join("\n");
    const text = `${heading}\n${body}`;

    sendChain = sendChain
      .then(async () => {
        await sendTelegramMessage(params.token, params.chatId, text);
        lastSentAt = Date.now();
      })
      .catch(() => {});

    await sendChain;

    if (!closed && queue.length > 0 && sentCount < MAX_PROGRESS_MESSAGES) {
      flushTimer = setTimeout(() => {
        void flush();
      }, 1400);
    }
  };

  const scheduleFlush = (): void => {
    if (flushTimer || closed) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, 900);
  };

  const unsubscribe = params.subscribeEvents({
    sessionId: params.sessionId,
    onEvent: (event) => {
      if (closed || sentCount >= MAX_PROGRESS_MESSAGES) {
        return;
      }
      const text = progressTextFromAgentEvent(event);
      if (!text) {
        return;
      }
      if (text === lastText) {
        return;
      }
      const now = Date.now();
      if (now - lastSentAt < 450) {
        return;
      }
      lastText = text;
      queue.push(text);
      scheduleFlush();
    }
  });

  return {
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      unsubscribe();
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await flush();
      await sendChain.catch(() => {});
    }
  };
}

async function resolveDmPolicy(): Promise<TelegramDmPolicy> {
  const config = await readConfig();
  return config.channels?.telegram?.dmPolicy ?? "pairing";
}

type TelegramTokenValidationResult =
  | { valid: true }
  | { valid: false; message: string; canRetry: boolean };

async function validateTelegramToken(token: string): Promise<TelegramTokenValidationResult> {
  try {
    await callTelegramApi(token, "getMe", {});
    return { valid: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const unauthorized = /401|403|Unauthorized/.test(message);
    return { valid: false, message, canRetry: !unauthorized };
  }
}

async function shouldAcceptMessage(params: {
  userId: number;
  chatId: number;
}): Promise<{ allowed: boolean; dmPolicy: TelegramDmPolicy; pairingCode?: string }> {
  const config = await readConfig();
  const dmPolicy = config.channels?.telegram?.dmPolicy ?? "pairing";

  if (dmPolicy === "disabled") {
    return { allowed: false, dmPolicy };
  }

  if (dmPolicy === "open") {
    return { allowed: true, dmPolicy };
  }

  if (dmPolicy === "allowlist") {
    return {
      allowed: isAllowedTelegramSender(config, params.userId) || isAllowedTelegramSender(config, params.chatId),
      dmPolicy
    };
  }

  if (isAllowedTelegramSender(config, params.userId) || isAllowedTelegramSender(config, params.chatId)) {
    return { allowed: true, dmPolicy };
  }

  const paired = await isPairingApproved({
    channel: "telegram",
    userId: String(params.userId),
    chatId: String(params.chatId)
  });

  if (paired) {
    return { allowed: true, dmPolicy };
  }

  const pending = await requestPairingCode({
    channel: "telegram",
    userId: String(params.userId),
    chatId: String(params.chatId)
  });

  return {
    allowed: false,
    dmPolicy,
    pairingCode: pending.code
  };
}

export async function startTelegramBridge(opts: TelegramBridgeOptions): Promise<TelegramBridge> {
  const status = await readOnboardingStatus();
  const token = resolveTelegramBotToken(status.config);
  if (!token) {
    return {
      enabled: false,
      info: "Telegram disabled (missing token). Set T560_TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      close: async () => {}
    };
  }

  let running = true;
  let offset = 0;
  const pollAbort = new AbortController();

  const loopPromise = (async () => {
    while (running) {
      try {
        const updates = await callTelegramApi<TelegramUpdate[]>(
          token,
          "getUpdates",
          {
            timeout: 25,
            offset,
            allowed_updates: ["message"]
          },
          pollAbort.signal
        );

        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);

          const text = update.message?.text?.trim();
          const chatId = update.message?.chat?.id;
          const fromId = update.message?.from?.id ?? chatId;

          if (!text || typeof chatId !== "number" || typeof fromId !== "number") {
            continue;
          }
          if (isHeartbeatCheckMessage(text)) {
            continue;
          }

          if (text === "/start") {
            await sendTelegramMessage(
              token,
              chatId,
              "t560 connected. Send a message and I will reply. Use /status for mode + onboarding status."
            );
            continue;
          }

          if (text === "/status") {
            const latestStatus = await readOnboardingStatus();
            const mode = latestStatus.onboarded ? "provider" : "foundation";
            const dmPolicy = await resolveDmPolicy();
            await sendTelegramMessage(
              token,
              chatId,
              `t560 status: ${mode}. dmPolicy=${dmPolicy}. Missing: ${latestStatus.missing.join(", ") || "none"}.`
            );
            continue;
          }

          if (text === "/new" || text === "/reset") {
            const sessionId = `telegram:${chatId}`;
            await clearSessionMessages(sessionId);
            await sendTelegramMessage(
              token,
              chatId,
              "Started a fresh chat session for this conversation."
            );
            continue;
          }

          const auth = await shouldAcceptMessage({
            userId: fromId,
            chatId
          });

          if (!auth.allowed) {
            if (auth.dmPolicy === "disabled") {
              await sendTelegramMessage(token, chatId, "Telegram DMs are disabled for this bot.");
              continue;
            }

            if (auth.dmPolicy === "allowlist") {
              await sendTelegramMessage(
                token,
                chatId,
                "This chat is not allowed. Ask the owner to allowlist your Telegram user/chat ID."
              );
              continue;
            }

            await sendTelegramMessage(
              token,
              chatId,
              [
                "Pairing required before I can respond in this chat.",
                `Your pairing code: ${auth.pairingCode ?? "(unknown)"}`,
                "Owner command:",
                `t560 pairing approve telegram ${auth.pairingCode ?? "<code>"}`
              ].join("\n")
            );
            continue;
          }

          const sessionId = `telegram:${chatId}`;
          const progressRelay = createTelegramProgressRelay({
            token,
            chatId,
            sessionId,
            subscribeEvents: opts.subscribeEvents
          });
          let reply: ChatResponse | null = null;
          try {
            reply = await opts.handleMessage({
              channel: "telegram",
              message: text,
              sessionId,
              externalUserId: String(fromId),
              receivedAt: Date.now()
            });
          } finally {
            await progressRelay.close();
          }
          if (!reply) {
            continue;
          }
          const formatted = formatTelegramResponse(reply);
          await sendTelegramMessage(token, chatId, formatted, "HTML");
        }
      } catch (error: unknown) {
        const err = error as NodeJS.ErrnoException;
        if (!running || err?.name === "AbortError") {
          return;
        }
        process.stderr.write(`[telegram] ${error instanceof Error ? error.message : String(error)}\n`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  })();

  return {
    enabled: true,
    info: "Telegram bridge active via long polling.",
    close: async () => {
      running = false;
      pollAbort.abort();
      await loopPromise;
    }
  };
}
