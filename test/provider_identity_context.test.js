import test from "node:test";
import assert from "node:assert/strict";

import {
  assertIdentityContextFilesInjected,
  assertSystemPromptHasIdentityFiles,
  assertSystemPromptHasIdentityContent,
  detectIdentityIntent,
  isIdentityAnswerGrounded,
  isSmallTalkMessage,
  assertToolSkillCoverage,
} from "../src/provider/run.ts";

test("identity context assertion passes when SOUL.md and USER.md are injected", () => {
  assert.doesNotThrow(() =>
    assertIdentityContextFilesInjected([
      { name: "SOUL.md", missing: false, content: "# soul" },
      { name: "USER.md", missing: false, content: "# user" },
      { name: "AGENTS.md", missing: false, content: "# agents" },
    ]),
  );
});

test("identity context assertion fails when SOUL.md is missing", () => {
  assert.throws(
    () =>
      assertIdentityContextFilesInjected([
        { name: "USER.md", missing: false, content: "# user" },
      ]),
    /SOUL\.md must be injected/i,
  );
});

test("identity context assertion fails when USER.md is missing", () => {
  assert.throws(
    () =>
      assertIdentityContextFilesInjected([
        { name: "SOUL.md", missing: false, content: "# soul" },
      ]),
    /USER\.md must be injected/i,
  );
});

test("system prompt assertion passes when SOUL.md and USER.md file blocks are present", () => {
  assert.doesNotThrow(() =>
    assertSystemPromptHasIdentityFiles(`
      <identity_context>
      <assistant_soul>x</assistant_soul>
      <user_profile>y</user_profile>
      </identity_context>
    `),
  );
});

test("system prompt assertion fails when USER.md block is missing", () => {
  assert.throws(
    () =>
      assertSystemPromptHasIdentityFiles(`
        <identity_context>
        <assistant_soul>x</assistant_soul>
        </identity_context>
      `),
    /missing injected user profile/i,
  );
});

test("system prompt assertion passes when SOUL.md and USER.md content is present", () => {
  assert.doesNotThrow(() =>
    assertSystemPromptHasIdentityContent({
      systemPrompt: `
        <identity_context>
        <assistant_soul># T560 Soul
        You are T560.</assistant_soul>
        <user_profile># User Profile
        Name: Nick</user_profile>
        </identity_context>
      `,
      soulContent: "# T560 Soul\n\nYou are T560.",
      userContent: "# User Profile\n\nName: Nick",
    }),
  );
});

test("system prompt assertion fails when SOUL.md content is missing", () => {
  assert.throws(
    () =>
      assertSystemPromptHasIdentityContent({
        systemPrompt: `
          <identity_context>
          <assistant_soul>(missing file)</assistant_soul>
          <user_profile># User Profile</user_profile>
          </identity_context>
        `,
        soulContent: "# T560 Soul",
        userContent: "# User Profile",
      }),
    /missing SOUL\.md content/i,
  );
});

test("tool skill coverage assertion fails for unmapped tools", () => {
  assert.throws(
    () =>
      assertToolSkillCoverage(["browser", "email"], {
        browser: "<tool_brief tool=\"browser\">...</tool_brief>",
      }),
    /Missing tool skill reminders/i,
  );
});

test("small talk detector keeps casual identity-adjacent greeting as small talk", () => {
  assert.equal(isSmallTalkMessage("hey"), true);
});

test("identity intent detects assistant-only name question", () => {
  assert.deepEqual(detectIdentityIntent("Hey whats your name again??"), {
    askAssistant: true,
    askUser: false,
  });
});

test("identity grounding rejects assistant-only reply that also mentions user", () => {
  const ok = isIdentityAnswerGrounded(
    "The assistant identity is T560 and the user identity is Nick.",
    { assistantName: "T560", userName: "Nick" },
    { askAssistant: true, askUser: false },
  );
  assert.equal(ok, false);
});

test("identity grounding accepts concise assistant-only reply", () => {
  const ok = isIdentityAnswerGrounded(
    "Hey, I'm T560.",
    { assistantName: "T560", userName: "Nick" },
    { askAssistant: true, askUser: false },
  );
  assert.equal(ok, true);
});
