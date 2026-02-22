import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { saveSession } from "../src/gateway/state.js";
import { dispatchToolCall } from "../src/tools/dispatch.js";

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t560-session-tools-"));
  return { dir, env: { ...process.env, T560_STATE_DIR: dir } };
}

test("sessions_list returns created sessions", async () => {
  const { env } = makeEnv();
  saveSession(
    "alpha",
    {
      messages: [{ role: "user", content: "hello" }],
      mode: "default",
      modelRefOverride: "",
      meta: { lastModelRef: "openai-codex/gpt-5.1-codex-mini" },
    },
    env,
  );

  const out = await dispatchToolCall({
    name: "sessions_list",
    arguments: JSON.stringify({ limit: 10 }),
    env,
    context: {},
  });

  assert.equal(out.ok, true);
  assert.equal(Array.isArray(out.sessions), true);
  assert.equal(out.sessions.some((s) => s.id === "alpha"), true);
});

test("sessions_list supports kinds and messageLimit", async () => {
  const { env } = makeEnv();
  saveSession(
    "telegram_group_1",
    {
      messages: [{ role: "user", content: "group-msg" }],
      mode: "default",
      modelRefOverride: "",
      meta: {},
    },
    env,
  );

  const out = await dispatchToolCall({
    name: "sessions_list",
    arguments: JSON.stringify({ kinds: ["group"], limit: 10, activeMinutes: null, messageLimit: 1 }),
    env,
    context: {},
  });

  assert.equal(out.ok, true);
  assert.equal(out.count, 1);
  assert.equal(out.sessions[0].kind, "group");
  assert.equal(out.sessions[0].messages.length, 1);
  assert.equal(out.sessions[0].messages[0].content, "group-msg");
});

test("sessions_history uses context session id when sessionId is null", async () => {
  const { env } = makeEnv();
  saveSession(
    "ctx_session",
    {
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ],
      mode: "default",
      modelRefOverride: "",
      meta: {},
    },
    env,
  );

  const out = await dispatchToolCall({
    name: "sessions_history",
    arguments: JSON.stringify({ sessionId: null, limit: 5 }),
    env,
    context: { sessionId: "ctx_session" },
  });

  assert.equal(out.ok, true);
  assert.equal(out.sessionId, "ctx_session");
  assert.equal(out.total, 2);
  assert.equal(out.messages.length, 2);
});

test("sessions_history accepts sessionKey alias", async () => {
  const { env } = makeEnv();
  saveSession(
    "alias_session",
    {
      messages: [{ role: "user", content: "alias" }],
      mode: "default",
      modelRefOverride: "",
      meta: {},
    },
    env,
  );
  const out = await dispatchToolCall({
    name: "sessions_history",
    arguments: JSON.stringify({ sessionKey: "alias_session", limit: 5 }),
    env,
    context: {},
  });
  assert.equal(out.ok, true);
  assert.equal(out.sessionId, "alias_session");
  assert.equal(out.total, 1);
});

test("sessions_history filters tool messages by default and can include them", async () => {
  const { env } = makeEnv();
  saveSession(
    "tool_filter_session",
    {
      messages: [
        { role: "tool", content: "internal" },
        { role: "assistant", content: "visible" },
      ],
      mode: "default",
      modelRefOverride: "",
      meta: {},
    },
    env,
  );

  const outDefault = await dispatchToolCall({
    name: "sessions_history",
    arguments: JSON.stringify({ sessionId: "tool_filter_session", sessionKey: null, limit: 10, includeTools: null }),
    env,
    context: {},
  });
  assert.equal(outDefault.ok, true);
  assert.equal(outDefault.total, 1);
  assert.equal(outDefault.messages.length, 1);
  assert.equal(outDefault.messages[0].role, "assistant");

  const outWithTools = await dispatchToolCall({
    name: "sessions_history",
    arguments: JSON.stringify({
      sessionId: "tool_filter_session",
      sessionKey: null,
      limit: 10,
      includeTools: true,
    }),
    env,
    context: {},
  });
  assert.equal(outWithTools.ok, true);
  assert.equal(outWithTools.total, 2);
  assert.equal(outWithTools.messages.length, 2);
});

test("session_status returns metadata and last model ref", async () => {
  const { env } = makeEnv();
  saveSession(
    "status_session",
    {
      messages: [{ role: "assistant", content: "done" }],
      mode: "coding",
      modelRefOverride: "openai-codex/gpt-5.2-codex",
      meta: { lastModelRef: "openai-codex/gpt-5.2-codex" },
    },
    env,
  );

  const out = await dispatchToolCall({
    name: "session_status",
    arguments: JSON.stringify({ sessionId: "status_session" }),
    env,
    context: {},
  });

  assert.equal(out.ok, true);
  assert.equal(out.mode, "coding");
  assert.equal(out.lastModelRef, "openai-codex/gpt-5.2-codex");
  assert.equal(out.lastMessageRole, "assistant");
});

test("agents_list returns main when no configured agents", async () => {
  const { env } = makeEnv();
  const out = await dispatchToolCall({
    name: "agents_list",
    arguments: "{}",
    env,
    context: { sessionId: "main" },
  });
  assert.equal(out.ok, true);
  assert.equal(Array.isArray(out.agents), true);
  assert.equal(out.agents.length > 0, true);
  assert.equal(out.agents[0].id, "main");
});

test("sessions_send resolves target by label and invokes runtime bridge", async () => {
  const { env } = makeEnv();
  saveSession(
    "agent:main:worker-1",
    {
      messages: [],
      mode: "default",
      modelRefOverride: "",
      meta: { label: "worker-one" },
    },
    env,
  );

  const calls = [];
  const out = await dispatchToolCall({
    name: "sessions_send",
    arguments: JSON.stringify({
      sessionKey: null,
      label: "worker-one",
