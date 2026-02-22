import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dispatchToolCall } from "../src/tools/dispatch.js";
import { loadConfig, saveConfig } from "../src/config/store.js";
import { loadSession } from "../src/gateway/state.js";

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t560-gw-cron-tools-"));
  return { dir, env: { ...process.env, T560_STATE_DIR: dir } };
}

test("gateway config.get/config.patch uses hash guard", async () => {
  const { env } = makeEnv();
  saveConfig(
    {
      workspaceDir: "/tmp/work",
      tools: { terminal: { enabled: false } },
    },
    env,
  );

  const got = await dispatchToolCall({
    name: "gateway",
    arguments: JSON.stringify({
      action: "config.get",
      delayMs: null,
      reason: null,
      gatewayUrl: null,
      gatewayToken: null,
      timeoutMs: null,
      raw: null,
      baseHash: null,
      sessionKey: null,
      note: null,
      restartDelayMs: null,
    }),
    env,
    context: {},
  });
  assert.equal(got.ok, true);
  assert.equal(typeof got.result?.hash, "string");
  assert.equal(typeof got.result?.raw, "string");

  const patched = await dispatchToolCall({
    name: "gateway",
    arguments: JSON.stringify({
      action: "config.patch",
      delayMs: null,
      reason: null,
      gatewayUrl: null,
      gatewayToken: null,
      timeoutMs: null,
      raw: JSON.stringify({ tools: { terminal: { enabled: true } } }),
      baseHash: got.result.hash,
      sessionKey: null,
      note: "test patch",
      restartDelayMs: 0,
    }),
    env,
    context: {},
  });
  assert.equal(patched.ok, true);

  const cfg = loadConfig(env).config;
  assert.equal(cfg?.tools?.terminal?.enabled, true);

  const conflict = await dispatchToolCall({
    name: "gateway",
    arguments: JSON.stringify({
      action: "config.patch",
      delayMs: null,
      reason: null,
      gatewayUrl: null,
      gatewayToken: null,
      timeoutMs: null,
      raw: JSON.stringify({ tools: { terminal: { enabled: false } } }),
      baseHash: "bad-hash",
      sessionKey: null,
      note: null,
      restartDelayMs: 0,
    }),
    env,
    context: {},
  });
  assert.equal(conflict.ok, false);
  assert.match(String(conflict.error ?? ""), /hash mismatch/i);
});

test("gateway restart writes restart sentinel payload", async () => {
  const { env, dir } = makeEnv();
  const out = await dispatchToolCall({
    name: "gateway",
    arguments: JSON.stringify({
      action: "restart",
      delayMs: 1500,
      reason: "test restart",
      gatewayUrl: null,
      gatewayToken: null,
      timeoutMs: null,
      raw: null,
      baseHash: null,
      sessionKey: "main",
      note: "unit",
      restartDelayMs: null,
    }),
    env,
    context: { sessionId: "main" },
  });
  assert.equal(out.ok, true);
  assert.equal(out.result?.scheduled, true);
  const p = path.join(dir, "gateway_restart.json");
  assert.equal(fs.existsSync(p), true);
});

test("cron add/list/run agentTurn uses invokeSession bridge", async () => {
  const { env } = makeEnv();
  const added = await dispatchToolCall({
    name: "cron",
    arguments: JSON.stringify({
      action: "add",
      gatewayUrl: null,
      gatewayToken: null,
      timeoutMs: null,
      includeDisabled: null,
      job: {
        name: "agent-turn-job",
        schedule: { kind: "every", everyMs: 1000, anchorMs: 0 },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "hello from cron" },
      },
      jobId: null,
      id: null,
      patch: null,
      text: null,
      mode: null,
      runMode: null,
      contextMessages: null,
    }),
    env,
    context: { sessionId: "main" },
  });
  assert.equal(added.ok, true);
  assert.equal(typeof added.job?.id, "string");

  const listed = await dispatchToolCall({
    name: "cron",
    arguments: JSON.stringify({
      action: "list",
      gatewayUrl: null,
      gatewayToken: null,
      timeoutMs: null,
      includeDisabled: true,
      job: null,
      jobId: null,
      id: null,
      patch: null,
      text: null,
      mode: null,
      runMode: null,
      contextMessages: null,
    }),
    env,
    context: { sessionId: "main" },
  });
  assert.equal(listed.ok, true);
  assert.equal(Array.isArray(listed.jobs), true);
  assert.equal(listed.jobs.length, 1);

  const calls = [];
  const ran = await dispatchToolCall({
    name: "cron",
    arguments: JSON.stringify({
      action: "run",
      gatewayUrl: null,
      gatewayToken: null,
      timeoutMs: null,
      includeDisabled: null,
      job: null,
      jobId: added.job.id,
      id: null,
      patch: null,
      text: null,
      mode: null,
      runMode: "force",
      contextMessages: null,
    }),
    env,
    context: {
      sessionId: "main",
      invokeSession: async (params) => {
        calls.push(params);
        return { ok: true, status: "ok", runId: params.runId, reply: "done" };
      },
    },
  });
  assert.equal(ran.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0].message), "hello from cron");
});

test("cron run systemEvent appends event text to target session", async () => {
  const { env } = makeEnv();
  const add = await dispatchToolCall({
    name: "cron",
    arguments: JSON.stringify({
      action: "add",
      gatewayUrl: null,
      gatewayToken: null,
      timeoutMs: null,
      includeDisabled: null,
      job: {
        name: "system-event-job",
        schedule: { kind: "every", everyMs: 1000, anchorMs: 0 },
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "remember this" },
      },
      jobId: null,
      id: null,
      patch: null,
      text: null,
      mode: null,
      runMode: null,
      contextMessages: null,
    }),
    env,
    context: { sessionId: "terminal" },
  });
  assert.equal(add.ok, true);

  const run = await dispatchToolCall({
    name: "cron",
    arguments: JSON.stringify({
      action: "run",
      gatewayUrl: null,
      gatewayToken: null,
      timeoutMs: null,
      includeDisabled: null,
      job: null,
      jobId: add.job.id,
      id: null,
      patch: null,
      text: null,
      mode: null,
      runMode: "force",
      contextMessages: null,
    }),
    env,
    context: { sessionId: "terminal" },
  });
  assert.equal(run.ok, true);

  const snap = loadSession("terminal", env).session;
  const messages = Array.isArray(snap?.messages) ? snap.messages : [];
  assert.equal(messages.length > 0, true);
  assert.match(String(messages[messages.length - 1]?.content ?? ""), /Cron System Event/i);
});

test("cron wake now executes due jobs and returns run records", async () => {
  const { env } = makeEnv();
  const add = await dispatchToolCall({
    name: "cron",
    arguments: JSON.stringify({
      action: "add",
      gatewayUrl: null,
      gatewayToken: null,
      timeoutMs: null,
      includeDisabled: null,
      job: {
        name: "due-job",
        schedule: { kind: "every", everyMs: 1, anchorMs: 0 },
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "wake run" },
      },
      jobId: null,
      id: null,
      patch: null,
      text: null,
      mode: null,
      runMode: null,
      contextMessages: null,
    }),
    env,
    context: { sessionId: "terminal" },
  });
  assert.equal(add.ok, true);

  const wake = await dispatchToolCall({
    name: "cron",
    arguments: JSON.stringify({
      action: "wake",
      gatewayUrl: null,
      gatewayToken: null,
      timeoutMs: null,
      includeDisabled: null,
      job: null,
      jobId: null,
      id: null,
      patch: null,
      text: "wake now",
      mode: "now",
      runMode: null,
      contextMessages: null,
    }),
    env,
    context: { sessionId: "terminal" },
  });
  assert.equal(wake.ok, true);
  assert.equal(wake.wake.mode, "now");

  const runs = await dispatchToolCall({
    name: "cron",
    arguments: JSON.stringify({
      action: "runs",
      gatewayUrl: null,
      gatewayToken: null,
      timeoutMs: null,
