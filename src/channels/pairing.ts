import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolvePairingPath } from "../config/state.js";

type PendingPairing = {
  id: string;
  channel: string;
  userId: string;
  chatId: string;
  code: string;
  createdAt: number;
  lastSeenAt: number;
};

type PairingStore = {
  version: number;
  approved: Record<string, string[]>;
  pending: PendingPairing[];
};

const DEFAULT_STORE: PairingStore = {
  version: 1,
  approved: {},
  pending: [],
};

function pairingId(channel: string, userId: string, chatId: string): string {
  return `${channel}:${userId}:${chatId}`;
}

function normalizeStore(raw: unknown): PairingStore {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_STORE };
  }
  const obj = raw as Record<string, unknown>;

  const approvedRaw = obj.approved;
  const approved: Record<string, string[]> = {};
  if (approvedRaw && typeof approvedRaw === "object") {
    for (const [channel, entries] of Object.entries(approvedRaw as Record<string, unknown>)) {
      if (!Array.isArray(entries)) {
        continue;
      }
      const cleaned = entries.map((entry) => String(entry).trim()).filter(Boolean);
      if (cleaned.length > 0) {
        approved[channel] = Array.from(new Set(cleaned));
      }
    }
  }

  const pendingRaw = Array.isArray(obj.pending) ? obj.pending : [];
  const pending: PendingPairing[] = pendingRaw
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => {
      const item = entry as Record<string, unknown>;
      return {
        id: String(item.id ?? "").trim(),
        channel: String(item.channel ?? "").trim(),
        userId: String(item.userId ?? "").trim(),
        chatId: String(item.chatId ?? "").trim(),
        code: String(item.code ?? "").trim().toUpperCase(),
        createdAt: Number(item.createdAt ?? Date.now()),
        lastSeenAt: Number(item.lastSeenAt ?? Date.now()),
      };
    })
    .filter((entry) => entry.id && entry.channel && entry.userId && entry.chatId && entry.code);

  return {
    version: 1,
    approved,
    pending,
  };
}

async function readStore(): Promise<PairingStore> {
  try {
    const raw = await readFile(resolvePairingPath(), "utf-8");
    return normalizeStore(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_STORE };
  }
}

async function writeStore(store: PairingStore): Promise<void> {
  await writeFile(resolvePairingPath(), `${JSON.stringify(store, null, 2)}\n`, "utf-8");
}

function generateCode(): string {
  // Human-friendly: uppercase alphanumeric, remove ambiguous chars.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let output = "";
  for (let i = 0; i < 8; i += 1) {
    output += alphabet[bytes[i] % alphabet.length];
  }
  return output;
}

export async function isPairingApproved(params: {
  channel: string;
  userId: string;
  chatId: string;
}): Promise<boolean> {
  const store = await readStore();
  const channel = params.channel.trim();
  const userId = params.userId.trim();
  const chatId = params.chatId.trim();
  const id = pairingId(channel, userId, chatId);

  const approved = store.approved[channel] ?? [];
  return approved.includes(id) || approved.includes(userId) || approved.includes(chatId);
}

export async function requestPairingCode(params: {
  channel: string;
  userId: string;
  chatId: string;
}): Promise<{ code: string; created: boolean }> {
  const store = await readStore();
  const channel = params.channel.trim();
  const userId = params.userId.trim();
  const chatId = params.chatId.trim();
  const id = pairingId(channel, userId, chatId);
  const now = Date.now();

  const existing = store.pending.find((entry) => entry.id === id);
  if (existing) {
    existing.lastSeenAt = now;
    await writeStore(store);
    return { code: existing.code, created: false };
  }

  const used = new Set(store.pending.map((entry) => entry.code));
  let code = "";
  for (let i = 0; i < 64; i += 1) {
    const candidate = generateCode();
    if (!used.has(candidate)) {
      code = candidate;
      break;
    }
  }
  if (!code) {
    code = generateCode();
  }

  store.pending.push({
    id,
    channel,
    userId,
    chatId,
    code,
    createdAt: now,
    lastSeenAt: now,
  });
  await writeStore(store);
  return { code, created: true };
}

export async function listPendingPairings(params?: {
  channel?: string;
}): Promise<PendingPairing[]> {
  const store = await readStore();
  const channel = params?.channel?.trim();
  const list = channel
    ? store.pending.filter((entry) => entry.channel === channel)
    : store.pending;
  return [...list].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export async function approvePairingCode(params: {
  channel: string;
  code: string;
}): Promise<PendingPairing | null> {
  const store = await readStore();
  const channel = params.channel.trim();
  const code = params.code.trim().toUpperCase();
  if (!channel || !code) {
    return null;
  }

  const index = store.pending.findIndex(
    (entry) => entry.channel === channel && entry.code === code
  );
  if (index === -1) {
    return null;
  }

  const pending = store.pending[index];
  store.pending.splice(index, 1);

  const approved = new Set(store.approved[channel] ?? []);
  approved.add(pending.id);
  approved.add(pending.userId);
  approved.add(pending.chatId);
  store.approved[channel] = Array.from(approved);

  await writeStore(store);
  return pending;
}
