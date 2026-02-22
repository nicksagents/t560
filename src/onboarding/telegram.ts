type TelegramUpdate = {
  update_id: number;
  message?: {
    chat?: {
      id?: number | string;
      type?: string;
      username?: string;
      first_name?: string;
      last_name?: string;
      title?: string;
    };
    text?: string;
  };
};

export type TelegramChatOption = {
  id: string;
  label: string;
};

export function validateTelegramBotToken(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Required";
  }
  if (!trimmed.includes(":")) {
    return "Token should look like <id>:<secret>";
  }
  return undefined;
}

async function callTelegramApi<T>(botToken: string, method: string, payload?: Record<string, unknown>): Promise<T> {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const response = await fetch(url, {
    method: payload ? "POST" : "GET",
    headers: payload ? { "content-type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const parsed = (await response.json()) as { ok?: boolean; result?: T; description?: string };
  if (!response.ok || !parsed.ok || parsed.result === undefined) {
    throw new Error(parsed.description || `Telegram ${method} failed (${response.status})`);
  }
  return parsed.result;
}

export async function verifyTelegramToken(botToken: string): Promise<{ username: string; id: string }> {
  const me = await callTelegramApi<{ id: number; username?: string }>(botToken, "getMe");
  return {
    id: String(me.id),
    username: me.username || "unknown",
  };
}

export async function discoverTelegramChats(botToken: string): Promise<TelegramChatOption[]> {
  const updates = await callTelegramApi<TelegramUpdate[]>(botToken, "getUpdates", { timeout: 1, limit: 50 });
  const map = new Map<string, TelegramChatOption>();
  for (const item of updates) {
    const chat = item.message?.chat;
    if (!chat?.id) {
      continue;
    }
    const chatId = String(chat.id);
    const parts = [chat.username, chat.first_name, chat.last_name, chat.title].filter(Boolean);
    const labelSuffix = parts.length > 0 ? ` (${parts.join(" ")})` : "";
    map.set(chatId, { id: chatId, label: `${chatId}${labelSuffix}` });
  }
  return Array.from(map.values());
}

