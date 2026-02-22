import type { OpenClawConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import {
  listTelegramAccountIds,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
} from "../../../telegram/accounts.js";
import { formatDocsLink } from "../../../terminal/links.js";
import { addWildcardAllowFrom, promptAccountId } from "./helpers.js";

const channel = "telegram" as const;

function normalizeTelegramAllowFromForDmPolicy(
  allowFrom: Array<string | number> | undefined,
  dmPolicy: DmPolicy,
) {
  if (dmPolicy === "open") {
    return addWildcardAllowFrom(allowFrom);
  }
  if (!allowFrom?.length) {
    return undefined;
  }
  const cleaned = allowFrom.filter((entry) => String(entry).trim() !== "*");
  return cleaned.length > 0 ? cleaned : undefined;
}

function setTelegramDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy) {
  const allowFrom = normalizeTelegramAllowFromForDmPolicy(
    cfg.channels?.telegram?.allowFrom,
    dmPolicy,
  );
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      telegram: {
        ...cfg.channels?.telegram,
        dmPolicy,
        allowFrom,
      },
    },
  };
}

function setTelegramDmPolicyForAccount(
  cfg: OpenClawConfig,
  accountId: string,
  dmPolicy: DmPolicy,
): OpenClawConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const next = setTelegramDmPolicy(cfg, dmPolicy);
    return {
      ...next,
      channels: {
        ...next.channels,
        telegram: {
          ...next.channels?.telegram,
          enabled: true,
        },
      },
    };
  }

  const existingAccount = cfg.channels?.telegram?.accounts?.[accountId];
  const allowFrom = normalizeTelegramAllowFromForDmPolicy(existingAccount?.allowFrom, dmPolicy);
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      telegram: {
        ...cfg.channels?.telegram,
        enabled: true,
        accounts: {
          ...cfg.channels?.telegram?.accounts,
          [accountId]: {
            ...existingAccount,
            enabled: existingAccount?.enabled ?? true,
            dmPolicy,
            allowFrom,
          },
        },
      },
    },
  };
}

async function noteTelegramTokenHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Open Telegram and chat with @BotFather",
      "2) Run /newbot (or /mybots)",
      "3) Copy the token (looks like 123456:ABC...)",
      "Tip: you can also set TELEGRAM_BOT_TOKEN in your env.",
      `Docs: ${formatDocsLink("/telegram")}`,
      "Website: https://t560.ai",
    ].join("\n"),
    "Telegram bot token",
  );
}

async function noteTelegramUserIdHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      `1) DM your bot, then read from.id in \`${formatCliCommand("t560 logs --follow")}\` (safest)`,
      "2) Or call https://api.telegram.org/bot<bot_token>/getUpdates and read message.from.id",
      "3) Third-party: DM @userinfobot or @getidsbot",
      `Docs: ${formatDocsLink("/telegram")}`,
      "Website: https://t560.ai",
    ].join("\n"),
    "Telegram user id",
  );
}

async function promptTelegramQuickstartDmAccess(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, accountId } = params;
  await prompter.note(
    [
      "After setup, send any message to your bot in Telegram.",
      "",
      "Pairing (recommended):",
      "- Unknown DMs receive a pairing code.",
      `- Approve with \`${formatCliCommand("t560 pairing approve telegram <code>")}\`.`,
      "",
      "Open (not recommended):",
      "- Anyone who can DM your bot can use the agent.",
      "",
      `Docs: ${formatDocsLink("/start/pairing", "docs.t560.ai/start/pairing")}`,
    ].join("\n"),
    "Telegram DM access",
  );

  const policy = (await prompter.select({
    message: "Telegram DM access (QuickStart)",
    options: [
      { value: "pairing", label: "Pairing (recommended)" },
      {
        value: "open",
        label: "Open (not recommended)",
        hint: "Anyone who can message the bot can use it",
      },
    ],
    initialValue: "pairing",
  })) as DmPolicy;

  const next = setTelegramDmPolicyForAccount(cfg, accountId, policy);
  if (policy === "open") {
    await prompter.note(
      [
        "Open mode enabled.",
        "This is not recommended for untrusted chats.",
        "Use pairing or allowlist if you want sender approval.",
      ].join("\n"),
      "Telegram warning",
    );
  }
  return next;
}

async function promptTelegramAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveTelegramAccount({ cfg, accountId });
  const existingAllowFrom = resolved.config.allowFrom ?? [];
  await noteTelegramUserIdHelp(prompter);

  const token = resolved.token;
  if (!token) {
    await prompter.note("Telegram token missing; username lookup is unavailable.", "Telegram");
  }

  const resolveTelegramUserId = async (raw: string): Promise<string | null> => {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    const stripped = trimmed.replace(/^(telegram|tg):/i, "").trim();
    if (/^\d+$/.test(stripped)) {
      return stripped;
    }
    if (!token) {
      return null;
    }
    const username = stripped.startsWith("@") ? stripped : `@${stripped}`;
    const url = `https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(username)}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
      if (!res.ok) {
        return null;
      }
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        result?: { id?: number | string };
      } | null;
      const id = data?.ok ? data?.result?.id : undefined;
      if (typeof id === "number" || typeof id === "string") {
        return String(id);
      }
      return null;
    } catch {
      // Network/timeout during username lookup - return null to prompt for numeric ID.
      return null;
    }
  };

  const parseInput = (value: string) =>
    value
      .split(/[\n,;]+/g)
      .map((entry) => entry.trim())
      .filter(Boolean);

  const shouldSkipAllowlist = (value: string): boolean => {
    const normalized = value.trim().toLowerCase();
    return normalized === "skip" || normalized === "later";
  };

  let resolvedIds: string[] = [];
  while (resolvedIds.length === 0) {
    const entry = await prompter.text({
      message: "Telegram allowFrom (username or user id)",
      placeholder: "@username",
      initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
      validate: (value) => {
        const trimmed = String(value ?? "").trim();
        if (!trimmed) {
          return "Required (or type 'skip' to use pairing for now)";
        }
        return undefined;
      },
    });
    const entryText = String(entry ?? "").trim();
    if (shouldSkipAllowlist(entryText)) {
      await prompter.note(
        [
          "Skipping Telegram allowlist for now.",
          "DM policy set to pairing (safer default).",
          `You can configure allowlist later via \`${formatCliCommand("t560 channels add telegram")}\`.`,
        ].join("\n"),
        "Telegram allowlist",
      );
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            telegram: {
              ...cfg.channels?.telegram,
              enabled: true,
              dmPolicy: "pairing",
            },
          },
        };
      }
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          telegram: {
            ...cfg.channels?.telegram,
            enabled: true,
            accounts: {
              ...cfg.channels?.telegram?.accounts,
              [accountId]: {
                ...cfg.channels?.telegram?.accounts?.[accountId],
                enabled: cfg.channels?.telegram?.accounts?.[accountId]?.enabled ?? true,
                dmPolicy: "pairing",
              },
            },
          },
        },
      };
    }
    const parts = parseInput(entryText);
    const results = await Promise.all(parts.map((part) => resolveTelegramUserId(part)));
    const unresolved = parts.filter((_, idx) => !results[idx]);
    if (unresolved.length > 0) {
      await prompter.note(
        `Could not resolve: ${unresolved.join(", ")}. Use @username or numeric id.`,
        "Telegram allowlist",
      );
      continue;
    }
    resolvedIds = results.filter(Boolean) as string[];
  }

  const merged = [
    ...existingAllowFrom.map((item) => String(item).trim()).filter(Boolean),
    ...resolvedIds,
  ];
  const unique = [...new Set(merged)];

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        telegram: {
          ...cfg.channels?.telegram,
          enabled: true,
          dmPolicy: "allowlist",
          allowFrom: unique,
        },
      },
    };
  }

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      telegram: {
        ...cfg.channels?.telegram,
        enabled: true,
        accounts: {
          ...cfg.channels?.telegram?.accounts,
          [accountId]: {
            ...cfg.channels?.telegram?.accounts?.[accountId],
            enabled: cfg.channels?.telegram?.accounts?.[accountId]?.enabled ?? true,
            dmPolicy: "allowlist",
            allowFrom: unique,
          },
        },
      },
    },
  };
}

async function promptTelegramAllowFromForAccount(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const accountId =
    params.accountId && normalizeAccountId(params.accountId)
      ? (normalizeAccountId(params.accountId) ?? DEFAULT_ACCOUNT_ID)
      : resolveDefaultTelegramAccountId(params.cfg);
  return promptTelegramAllowFrom({
    cfg: params.cfg,
    prompter: params.prompter,
    accountId,
  });
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Telegram",
  channel,
  policyKey: "channels.telegram.dmPolicy",
  allowFromKey: "channels.telegram.allowFrom",
  getCurrent: (cfg) => cfg.channels?.telegram?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setTelegramDmPolicy(cfg, policy),
