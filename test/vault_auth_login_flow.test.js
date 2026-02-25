import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getCredential, setCredential } from "../src/security/credentials-vault.ts";
import { resolveSkillsPromptForRun } from "../src/agents/skills.ts";

async function withTempHome(fn) {
  const previousHome = process.env.HOME;
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "t560-auth-home-"));
  process.env.HOME = tempHome;
  try {
    await fn();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
}

test("vault infers MFA source mailbox service from identifier when mailbox creds are configured", async () => {
  await withTempHome(async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "t560-auth-workspace-"));
    try {
      await setCredential({
        workspaceDir,
        service: "mail.google.com",
        identifier: "nick@gmail.com",
        secret: "mail-secret",
        authMode: "password",
      });

      await setCredential({
        workspaceDir,
        service: "securebank.example.com",
        identifier: "nick@gmail.com",
        secret: "vault-secret",
        authMode: "password_with_mfa",
      });

      const credential = await getCredential({
        workspaceDir,
        service: "securebank.example.com",
      });
      assert.ok(credential);
      assert.equal(credential.authMode, "password_with_mfa");
      assert.equal(credential.mfaSourceService, "mail.google.com");
      assert.equal(credential.mfaStrategy, "email_or_user");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

test("vault does not auto-link MFA mailbox when identifiers do not match", async () => {
  await withTempHome(async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "t560-auth-workspace-"));
    try {
      await setCredential({
        workspaceDir,
        service: "mail.google.com",
        identifier: "different@gmail.com",
        secret: "mail-secret",
        authMode: "password",
      });

      await setCredential({
        workspaceDir,
        service: "securebank.example.com",
        identifier: "nick@gmail.com",
        secret: "vault-secret",
        authMode: "password_with_mfa",
      });

      const credential = await getCredential({
        workspaceDir,
        service: "securebank.example.com",
      });
      assert.ok(credential);
      assert.equal(credential.authMode, "password_with_mfa");
      assert.equal("mfaSourceService" in credential, false);
      assert.equal(credential.mfaStrategy, "user_prompt");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

test("vault does not attach mfaSourceService for plain password auth", async () => {
  await withTempHome(async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "t560-auth-workspace-"));
    try {
      await setCredential({
        workspaceDir,
        service: "mail.google.com",
        identifier: "nick@example.com",
        secret: "mail-secret",
        authMode: "password",
      });

      await setCredential({
        workspaceDir,
        service: "example.com",
        identifier: "nick@gmail.com",
        secret: "example-secret",
        authMode: "password",
      });

      const credential = await getCredential({
        workspaceDir,
        service: "example.com",
      });
      assert.ok(credential);
      assert.equal(credential.authMode, "password");
      assert.equal("mfaSourceService" in credential, false);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

test("skills prompt includes concrete SKILL.md file locations", async () => {
  const prompt = await resolveSkillsPromptForRun({
    workspaceDir: process.cwd(),
  });
  assert.ok(prompt);
  assert.match(String(prompt), /web-login-vault: .*\(file: .*skills\/web-login-vault\/SKILL\.md\)/);
});
