import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/state.js";

type UsageLike = {
  input?: unknown;
  output?: unknown;
  totalTokens?: unknown;
  cost?: {
    total?: unknown;
  };
};

type AssistantLike = {
  role?: unknown;
  provider?: unknown;
  model?: unknown;
  usage?: UsageLike;
};

type ProviderUsageTotals = {
  messages: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
};

export type UsageStatusSummary = {
  sessionsScanned: number;
  messagesScanned: number;
  assistantMessagesWithUsage: number;
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
  };
  byProvider: Record<string, ProviderUsageTotals>;
  budget: {
    tokenBudget: number | null;
    tokensRemaining: number | null;
    costBudgetUsd: number | null;
    costRemainingUsd: number | null;
  };
  quota: {
    provider: string | null;
    model: string | null;
    available: false;
    message: string;
  };
  note: string;
};

function asFiniteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toBudgetOrNull(raw: string | undefined): number | null {
  const n = Number(raw ?? "");
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return n;
}

function toFixedUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isAssistantWithUsage(message: unknown): message is AssistantLike {
  if (!message || typeof message !== "object") {
    return false;
  }
  const obj = message as Record<string, unknown>;
  return obj.role === "assistant" && !!obj.usage && typeof obj.usage === "object";
}

export async function summarizeSavedUsage(params: {
  activeProvider?: string | null;
  activeModel?: string | null;
  configuredBudget?: {
    tokenBudget?: number | null;
    costBudgetUsd?: number | null;
  };
}): Promise<UsageStatusSummary> {
  const sessionsDir = path.join(resolveStateDir(), "sessions");
  let files: string[] = [];
  try {
    files = (await readdir(sessionsDir)).filter((name) => name.endsWith(".json"));
  } catch {
    files = [];
  }

  let messagesScanned = 0;
  let assistantMessagesWithUsage = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let costUsd = 0;
  const byProvider: Record<string, ProviderUsageTotals> = {};

  for (const filename of files) {
    const filePath = path.join(sessionsDir, filename);
    let rawMessages: unknown = null;
    try {
      rawMessages = JSON.parse(await readFile(filePath, "utf-8"));
    } catch {
      continue;
    }
    if (!Array.isArray(rawMessages)) {
      continue;
    }
    messagesScanned += rawMessages.length;

    for (const message of rawMessages) {
      if (!isAssistantWithUsage(message)) {
        continue;
      }
      assistantMessagesWithUsage += 1;
      const usage = message.usage ?? {};
      const inTokens = asFiniteNumber(usage.input);
      const outTokens = asFiniteNumber(usage.output);
      const allTokens = asFiniteNumber(usage.totalTokens) || inTokens + outTokens;
      const totalCost = asFiniteNumber(usage.cost?.total);

      inputTokens += inTokens;
      outputTokens += outTokens;
      totalTokens += allTokens;
      costUsd += totalCost;

      const providerKeyRaw = typeof message.provider === "string" ? message.provider.trim() : "";
      const providerKey = providerKeyRaw || "unknown";
      if (!byProvider[providerKey]) {
        byProvider[providerKey] = {
          messages: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        };
      }
      byProvider[providerKey].messages += 1;
      byProvider[providerKey].inputTokens += inTokens;
      byProvider[providerKey].outputTokens += outTokens;
      byProvider[providerKey].totalTokens += allTokens;
      byProvider[providerKey].costUsd = toFixedUsd(byProvider[providerKey].costUsd + totalCost);
    }
  }

  const tokenBudget =
    toBudgetOrNull(process.env.T560_USAGE_TOKEN_BUDGET) ??
    toBudgetOrNull(
      params.configuredBudget?.tokenBudget == null
        ? undefined
        : String(params.configuredBudget.tokenBudget)
    );
  const costBudgetUsd =
    toBudgetOrNull(process.env.T560_USAGE_COST_BUDGET_USD) ??
    toBudgetOrNull(
      params.configuredBudget?.costBudgetUsd == null
        ? undefined
        : String(params.configuredBudget.costBudgetUsd)
    );
  const tokensRemaining = tokenBudget == null ? null : Math.max(0, tokenBudget - totalTokens);
  const costRemainingUsd = costBudgetUsd == null ? null : toFixedUsd(Math.max(0, costBudgetUsd - costUsd));

  return {
    sessionsScanned: files.length,
    messagesScanned,
    assistantMessagesWithUsage,
    totals: {
      inputTokens,
      outputTokens,
      totalTokens,
      costUsd: toFixedUsd(costUsd),
    },
    byProvider,
    budget: {
      tokenBudget,
      tokensRemaining,
      costBudgetUsd,
      costRemainingUsd,
    },
    quota: {
      provider: params.activeProvider ?? null,
      model: params.activeModel ?? null,
      available: false,
      message:
        "Provider-side remaining quota is not exposed in a reliable, universal API for all providers/models.",
    },
    note:
      "Usage totals are estimated from locally saved recent session history (session files keep recent messages only).",
  };
}
