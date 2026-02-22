// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";
import { discordPlugin } from "../../extensions/discord/src/channel.js";
import { imessagePlugin } from "../../extensions/imessage/src/channel.js";
import { signalPlugin } from "../../extensions/signal/src/channel.js";
import { slackPlugin } from "../../extensions/slack/src/channel.js";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { whatsappPlugin } from "../../extensions/whatsapp/src/channel.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { setupChannels } from "./onboard-channels.js";
vi.mock("node:fs/promises", () => ({
    default: {
        access: vi.fn(async () => {
            throw new Error("ENOENT");
        }),
    },
}));
vi.mock("../channel-web.js", () => ({
    loginWeb: vi.fn(async () => { }),
}));
vi.mock("./onboard-helpers.js", () => ({
    detectBinary: vi.fn(async () => false),
}));
describe("setupChannels", () => {
    beforeEach(() => {
        setActivePluginRegistry(createTestRegistry([
            { pluginId: "discord", plugin: discordPlugin, source: "test" },
            { pluginId: "slack", plugin: slackPlugin, source: "test" },
            { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
            { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
            { pluginId: "signal", plugin: signalPlugin, source: "test" },
            { pluginId: "imessage", plugin: imessagePlugin, source: "test" },
        ]));
    });
    it("QuickStart uses single-select (no multiselect) and doesn't prompt for Telegram token when WhatsApp is chosen", async () => {
        const select = vi.fn(async () => "whatsapp");
        const multiselect = vi.fn(async () => {
            throw new Error("unexpected multiselect");
        });
        const text = vi.fn(async ({ message }) => {
            if (message.includes("Enter Telegram bot token")) {
                throw new Error("unexpected Telegram token prompt");
            }
            if (message.includes("Your personal WhatsApp number")) {
                return "+15555550123";
            }
            throw new Error(`unexpected text prompt: ${message}`);
        });
        const prompter = {
            intro: vi.fn(async () => { }),
            outro: vi.fn(async () => { }),
            note: vi.fn(async () => { }),
            select,
            multiselect,
            text: text,
            confirm: vi.fn(async () => false),
            progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
        };
        const runtime = {
            log: vi.fn(),
            error: vi.fn(),
            exit: vi.fn((code) => {
                throw new Error(`exit:${code}`);
            }),
        };
        await setupChannels({}, runtime, prompter, {
            skipConfirm: true,
            quickstartDefaults: true,
            forceAllowFromChannels: ["whatsapp"],
        });
        expect(select).toHaveBeenCalledWith(expect.objectContaining({ message: "Select channel (QuickStart)" }));
        expect(multiselect).not.toHaveBeenCalled();
    });
    it("QuickStart Telegram asks for token and DM mode, defaulting to pairing", async () => {
        const prevToken = process.env.TELEGRAM_BOT_TOKEN;
        delete process.env.TELEGRAM_BOT_TOKEN;
        try {
            const select = vi.fn(async ({ message, options }) => {
                if (message === "Select channel (QuickStart)") {
                    return "telegram";
                }
                if (message === "Telegram DM access (QuickStart)") {
                    const labels = (options ?? []).map((option) => option.label);
                    expect(labels).toContain("Open (not recommended)");
                    return "pairing";
                }
                throw new Error(`unexpected select prompt: ${message}`);
            });
            const text = vi.fn(async ({ message }) => {
                if (message === "Enter Telegram bot token") {
                    return "123:abc";
                }
                throw new Error(`unexpected text prompt: ${message}`);
            });
            const prompter = {
                intro: vi.fn(async () => { }),
                outro: vi.fn(async () => { }),
                note: vi.fn(async () => { }),
                select,
                multiselect: vi.fn(async () => {
                    throw new Error("unexpected multiselect");
                }),
                text: text,
                confirm: vi.fn(async () => false),
                progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
            };
            const runtime = {
                log: vi.fn(),
                error: vi.fn(),
                exit: vi.fn((code) => {
                    throw new Error(`exit:${code}`);
                }),
            };
            const next = await setupChannels({}, runtime, prompter, {
                skipConfirm: true,
                quickstartDefaults: true,
                skipDmPolicyPrompt: true,
            });
            expect(next.channels?.telegram?.botToken).toBe("123:abc");
            expect(next.channels?.telegram?.dmPolicy).toBe("pairing");
            expect(next.channels?.telegram?.allowFrom).toBeUndefined();
        }
        finally {
            if (prevToken === undefined) {
                delete process.env.TELEGRAM_BOT_TOKEN;
            }
            else {
                process.env.TELEGRAM_BOT_TOKEN = prevToken;
            }
        }
    });
    it("QuickStart Telegram open mode sets wildcard allowFrom", async () => {
        const prevToken = process.env.TELEGRAM_BOT_TOKEN;
        delete process.env.TELEGRAM_BOT_TOKEN;
        try {
            const select = vi.fn(async ({ message }) => {
                if (message === "Select channel (QuickStart)") {
                    return "telegram";
                }
                if (message === "Telegram DM access (QuickStart)") {
                    return "open";
                }
                throw new Error(`unexpected select prompt: ${message}`);
            });
            const text = vi.fn(async ({ message }) => {
                if (message === "Enter Telegram bot token") {
                    return "123:xyz";
                }
                throw new Error(`unexpected text prompt: ${message}`);
            });
            const prompter = {
                intro: vi.fn(async () => { }),
                outro: vi.fn(async () => { }),
                note: vi.fn(async () => { }),
                select,
                multiselect: vi.fn(async () => {
                    throw new Error("unexpected multiselect");
                }),
                text: text,
                confirm: vi.fn(async () => false),
                progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
            };
            const runtime = {
                log: vi.fn(),
                error: vi.fn(),
                exit: vi.fn((code) => {
                    throw new Error(`exit:${code}`);
                }),
            };
            const next = await setupChannels({}, runtime, prompter, {
                skipConfirm: true,
                quickstartDefaults: true,
                skipDmPolicyPrompt: true,
            });
            expect(next.channels?.telegram?.botToken).toBe("123:xyz");
            expect(next.channels?.telegram?.dmPolicy).toBe("open");
            expect(next.channels?.telegram?.allowFrom).toEqual(["*"]);
        }
        finally {
            if (prevToken === undefined) {
                delete process.env.TELEGRAM_BOT_TOKEN;
            }
            else {
                process.env.TELEGRAM_BOT_TOKEN = prevToken;
            }
        }
    });
    it("prompts for configured channel action and skips configuration when told to skip", async () => {
        const select = vi.fn(async ({ message }) => {
            if (message === "Select channel (QuickStart)") {
                return "telegram";
            }
            if (message.includes("already configured")) {
                return "skip";
            }
            throw new Error(`unexpected select prompt: ${message}`);
        });
        const multiselect = vi.fn(async () => {
            throw new Error("unexpected multiselect");
        });
        const text = vi.fn(async ({ message }) => {
            throw new Error(`unexpected text prompt: ${message}`);
        });
        const prompter = {
            intro: vi.fn(async () => { }),
            outro: vi.fn(async () => { }),
            note: vi.fn(async () => { }),
            select,
            multiselect,
            text: text,
            confirm: vi.fn(async () => false),
            progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
        };
        const runtime = {
            log: vi.fn(),
            error: vi.fn(),
            exit: vi.fn((code) => {
                throw new Error(`exit:${code}`);
            }),
        };
        await setupChannels({
            channels: {
                telegram: {
                    botToken: "token",
                },
            },
        }, runtime, prompter, {
            skipConfirm: true,
            quickstartDefaults: true,
        });
        expect(select).toHaveBeenCalledWith(expect.objectContaining({ message: "Select channel (QuickStart)" }));
        expect(select).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("already configured") }));
        expect(multiselect).not.toHaveBeenCalled();
        expect(text).not.toHaveBeenCalled();
    });
    it("adds disabled hint to channel selection when a channel is disabled", async () => {
        let selectionCount = 0;
        const select = vi.fn(async ({ message, options }) => {
            if (message === "Select a channel") {
                selectionCount += 1;
                const opts = options;
                const telegram = opts.find((opt) => opt.value === "telegram");
            }
        });
    });
});
