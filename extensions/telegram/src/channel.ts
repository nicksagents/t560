// @ts-nocheck
import { applyAccountNameToChannelSection, buildChannelConfigSchema, DEFAULT_ACCOUNT_ID, deleteAccountFromConfigSection, formatPairingApproveHint, getChatChannelMeta, listTelegramAccountIds, listTelegramDirectoryGroupsFromConfig, listTelegramDirectoryPeersFromConfig, looksLikeTelegramTargetId, normalizeAccountId, normalizeTelegramMessagingTarget, PAIRING_APPROVED_MESSAGE, resolveDefaultTelegramAccountId, resolveTelegramAccount, resolveTelegramGroupRequireMention, resolveTelegramGroupToolPolicy, setAccountEnabledInConfigSection, telegramOnboardingAdapter, TelegramConfigSchema, } from "openclaw/plugin-sdk";
import { getTelegramRuntime } from "./runtime.js";
const meta = getChatChannelMeta("telegram");
const telegramMessageActions = {
    listActions: (ctx) => getTelegramRuntime().channel.telegram.messageActions?.listActions?.(ctx) ?? [],
    extractToolSend: (ctx) => getTelegramRuntime().channel.telegram.messageActions?.extractToolSend?.(ctx) ?? null,
    handleAction: async (ctx) => {
        const ma = getTelegramRuntime().channel.telegram.messageActions;
        if (!ma?.handleAction) {
            throw new Error("Telegram message actions not available");
        }
        return ma.handleAction(ctx);
    },
};
function parseReplyToMessageId(replyToId) {
    if (!replyToId) {
        return undefined;
    }
    const parsed = Number.parseInt(replyToId, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function parseThreadId(threadId) {
    if (threadId == null) {
        return undefined;
    }
    if (typeof threadId === "number") {
        return Number.isFinite(threadId) ? Math.trunc(threadId) : undefined;
    }
    const trimmed = threadId.trim();
    if (!trimmed) {
        return undefined;
    }
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}
export const telegramPlugin = {
    id: "telegram",
    meta: {
        ...meta,
        quickstartAllowFrom: true,
    },
    onboarding: telegramOnboardingAdapter,
    pairing: {
        idLabel: "telegramUserId",
        normalizeAllowEntry: (entry) => entry.replace(/^(telegram|tg):/i, ""),
        notifyApproval: async ({ cfg, id }) => {
            const { token } = getTelegramRuntime().channel.telegram.resolveTelegramToken(cfg);
            if (!token) {
                throw new Error("telegram token not configured");
            }
            await getTelegramRuntime().channel.telegram.sendMessageTelegram(id, PAIRING_APPROVED_MESSAGE, {
                token,
            });
        },
    },
    capabilities: {
        chatTypes: ["direct", "group", "channel", "thread"],
        reactions: true,
        threads: true,
        media: true,
        nativeCommands: true,
        blockStreaming: true,
    },
    reload: { configPrefixes: ["channels.telegram"] },
    configSchema: buildChannelConfigSchema(TelegramConfigSchema),
    config: {
        listAccountIds: (cfg) => listTelegramAccountIds(cfg),
        resolveAccount: (cfg, accountId) => resolveTelegramAccount({ cfg, accountId }),
        defaultAccountId: (cfg) => resolveDefaultTelegramAccountId(cfg),
        setAccountEnabled: ({ cfg, accountId, enabled }) => setAccountEnabledInConfigSection({
            cfg,
            sectionKey: "telegram",
            accountId,
            enabled,
            allowTopLevel: true,
        }),
        deleteAccount: ({ cfg, accountId }) => deleteAccountFromConfigSection({
            cfg,
            sectionKey: "telegram",
            accountId,
            clearBaseFields: ["botToken", "tokenFile", "name"],
        }),
        isConfigured: (account) => Boolean(account.token?.trim()),
        describeAccount: (account) => ({
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured: Boolean(account.token?.trim()),
            tokenSource: account.tokenSource,
        }),
        resolveAllowFrom: ({ cfg, accountId }) => (resolveTelegramAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) => String(entry)),
        formatAllowFrom: ({ allowFrom }) => allowFrom
            .map((entry) => String(entry).trim())
            .filter(Boolean)
            .map((entry) => entry.replace(/^(telegram|tg):/i, ""))
            .map((entry) => entry.toLowerCase()),
    },
    security: {
        resolveDmPolicy: ({ cfg, accountId, account }) => {
            const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
            const useAccountPath = Boolean(cfg.channels?.telegram?.accounts?.[resolvedAccountId]);
            const basePath = useAccountPath
                ? `channels.telegram.accounts.${resolvedAccountId}.`
                : "channels.telegram.";
            return {
                policy: account.config.dmPolicy ?? "pairing",
                allowFrom: account.config.allowFrom ?? [],
                policyPath: `${basePath}dmPolicy`,
                allowFromPath: basePath,
                approveHint: formatPairingApproveHint("telegram"),
                normalizeEntry: (raw) => raw.replace(/^(telegram|tg):/i, ""),
            };
        },
        collectWarnings: ({ account, cfg }) => {
            const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
            const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
            if (groupPolicy !== "open") {
                return [];
            }
            const groupAllowlistConfigured = account.config.groups && Object.keys(account.config.groups).length > 0;
            if (groupAllowlistConfigured) {
                return [
                    `- Telegram groups: groupPolicy="open" allows any member in allowed groups to trigger (mention-gated). Set channels.telegram.groupPolicy="allowlist" + channels.telegram.groupAllowFrom to restrict senders.`,
                ];
            }
            return [
                `- Telegram groups: groupPolicy="open" with no channels.telegram.groups allowlist; any group can add + ping (mention-gated). Set channels.telegram.groupPolicy="allowlist" + channels.telegram.groupAllowFrom or configure channels.telegram.groups.`,
            ];
        },
    },
    groups: {
        resolveRequireMention: resolveTelegramGroupRequireMention,
        resolveToolPolicy: resolveTelegramGroupToolPolicy,
    },
    threading: {
        resolveReplyToMode: ({ cfg }) => cfg.channels?.telegram?.replyToMode ?? "first",
    },
    messaging: {
        normalizeTarget: normalizeTelegramMessagingTarget,
        targetResolver: {
            looksLikeId: looksLikeTelegramTargetId,
            hint: "<chatId>",
        },
    },
    directory: {
        self: async () => null,
        listPeers: async (params) => listTelegramDirectoryPeersFromConfig(params),
        listGroups: async (params) => listTelegramDirectoryGroupsFromConfig(params),
    },
    actions: telegramMessageActions,
    setup: {
        resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
        applyAccountName: ({ cfg, accountId, name }) => applyAccountNameToChannelSection({
            cfg,
            channelKey: "telegram",
            accountId,
            name,
        }),
        validateInput: ({ accountId, input }) => {
            if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
                return "TELEGRAM_BOT_TOKEN can only be used for the default account.";
            }
            if (!input.useEnv && !input.token && !input.tokenFile) {
                return "Telegram requires token or --token-file (or --use-env).";
            }
            return null;
        },
        applyAccountConfig: ({ cfg, accountId, input }) => {
            const namedConfig = applyAccountNameToChannelSection({
                cfg,
                channelKey: "telegram",
                accountId,
                name: input.name,
            });
        }
    }
};
