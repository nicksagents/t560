import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { processChatMessage } from "../src/agent/chat-service.ts";

async function seedOnboardedState(stateDir) {
  const config = {
    provider: "stub",
    providers: {
      stub: {
        enabled: true,
        provider: "unsupported-provider",
        authMode: "api_key",
        apiKey: "test-key",
        models: ["m-default", "m-planning", "m-coding"],
      },
    },
    routing: {
      default: { provider: "stub", model: "m-default" },
      planning: { provider: "stub", model: "m-planning" },
      coding: { provider: "stub", model: "m-coding" },
    },
    tools: {
      selfProtection: {
        enabled: true,
        installRoot: process.cwd(),
        protectedPaths: ["."],
      },
    },
  };

  await writeFile(path.join(stateDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  await writeFile(path.join(stateDir, "soul.md"), "# Soul\n\nTest soul\n", "utf-8");
  await writeFile(path.join(stateDir, "users.md"), "# Users\n\nTest users\n", "utf-8");
  await writeFile(path.join(stateDir, "user.md"), "# User\n\nLegacy user file\n", "utf-8");
}

async function withTempState(fn) {
  const previous = process.env.T560_STATE_DIR;
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "t560-routing-channels-"));
  process.env.T560_STATE_DIR = stateDir;
  try {
    await seedOnboardedState(stateDir);
    await fn(stateDir);
  } finally {
    if (previous === undefined) {
      delete process.env.T560_STATE_DIR;
    } else {
      process.env.T560_STATE_DIR = previous;
    }
  }
}

test("routing intent is consistent across terminal, webchat, and telegram channels", async () => {
  await withTempState(async () => {
    const coding = await processChatMessage({
      channel: "terminal",
      message: "please implement auth middleware in src/server.ts",
      sessionId: "terminal-s1",
      externalUserId: "terminal-u1",
      receivedAt: Date.now(),
    });
    assert.match(coding.message, /Provider error \(terminal\) route=coding via stub\/m-coding\./);

    const planning = await processChatMessage({
      channel: "webchat",
      message: "create a rollout plan for this migration",
      sessionId: "webchat-s1",
      externalUserId: "webchat-u1",
      receivedAt: Date.now(),
    });
    assert.match(planning.message, /Provider error \(webchat\) route=planning via stub\/m-planning\./);

    const general = await processChatMessage({
      channel: "telegram",
      message: "hey how are you today",
      sessionId: "telegram-s1",
      externalUserId: "telegram-u1",
      receivedAt: Date.now(),
    });
    assert.match(general.message, /Provider error \(telegram\) route=default via stub\/m-default\./);
  });
});
