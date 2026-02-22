import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { handleSecureSetupFlow, resetSetupFlowState } from "../src/security/setup-flow.js";
import {
  getCredential,
  listConfiguredServices,
  resolveWorkspaceVaultFile,
} from "../src/security/credentials-vault.js";

async function withTempHome(fn) {
  const previousHome = process.env.HOME;
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "t560-home-"));
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

test("secure setup flow stores encrypted email credentials without exposing secrets", async () => {
  await withTempHome(async () => {
    resetSetupFlowState();
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "t560-workspace-"));
    const sessionId = "setup-email-session";

    const start = await handleSecureSetupFlow({
      workspaceDir,
      sessionId,
      message: "/setup email",
    });
    assert.equal(start.handled, true);
    assert.match(start.message, /enter the email address/i);

    const askAuthMode = await handleSecureSetupFlow({
      workspaceDir,
      sessionId,
      message: "nick.vassallo97@gmail.com",
    });
    assert.equal(askAuthMode.handled, true);
    assert.match(askAuthMode.message, /choose auth mode/i);
    assert.doesNotMatch(askAuthMode.message, /nick\.vassallo97@gmail\.com/i);

    const askSecret = await handleSecureSetupFlow({
      workspaceDir,
      sessionId,
      message: "password",
    });
    assert.equal(askSecret.handled, true);
    assert.match(askSecret.message, /enter the app password/i);
    assert.doesNotMatch(askSecret.message, /nick\.vassallo97@gmail\.com/i);

    const saved = await handleSecureSetupFlow({
      workspaceDir,
      sessionId,
      message: "my-app-password-123",
    });
    assert.equal(saved.handled, true);
    assert.match(saved.message, /saved secure credentials/i);
    assert.doesNotMatch(saved.message, /my-app-password-123/i);

    const credential = await getCredential({
      workspaceDir,
      service: "email",
    });
    assert.ok(credential);
    assert.equal(credential.identifier, "nick.vassallo97@gmail.com");
    assert.equal(credential.secret, "my-app-password-123");
    assert.equal(credential.authMode, "password");

    const encryptedFile = resolveWorkspaceVaultFile(workspaceDir);
    const payload = await readFile(encryptedFile, "utf-8");
    assert.doesNotMatch(payload, /my-app-password-123/);
    assert.doesNotMatch(payload, /nick\.vassallo97@gmail\.com/);
  });
});

test("secure setup supports listing and clearing configured services", async () => {
  await withTempHome(async () => {
    resetSetupFlowState();
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "t560-workspace-"));
    const sessionId = "setup-services-session";

    const start = await handleSecureSetupFlow({
      workspaceDir,
      sessionId,
      message: "/setup havenvaults2-0",
    });
    assert.equal(start.handled, true);
    assert.match(start.message, /enter the login identifier/i);

    const askMode = await handleSecureSetupFlow({
      workspaceDir,
      sessionId,
      message: "nick-user",
    });
    assert.equal(askMode.handled, true);
    assert.match(askMode.message, /choose auth mode/i);

    const askMfaCode = await handleSecureSetupFlow({
      workspaceDir,
      sessionId,
      message: "/setup mode mfa",
    });
    assert.equal(askMfaCode.handled, true);
    assert.match(askMfaCode.message, /enter a default mfa code/i);

    const saved = await handleSecureSetupFlow({
      workspaceDir,
      sessionId,
      message: "skip",
    });
    assert.equal(saved.handled, true);
    assert.match(saved.message, /auth mode=passwordless mfa code/i);

    const listed = await handleSecureSetupFlow({
      workspaceDir,
      sessionId,
      message: "/setup list",
    });
    assert.equal(listed.handled, true);
    assert.match(listed.message, /havenvaults2-0/);

    const configured = await listConfiguredServices(workspaceDir);
    assert.deepEqual(configured, ["havenvaults2-0"]);

    const stored = await getCredential({
      workspaceDir,
      service: "havenvaults2-0",
    });
    assert.ok(stored);
    assert.equal(stored.authMode, "passwordless_mfa_code");
    assert.equal(stored.secret, "__PASSWORDLESS_MFA__");

    const cleared = await handleSecureSetupFlow({
      workspaceDir,
      sessionId,
      message: "/setup clear havenvaults2-0",
    });
    assert.equal(cleared.handled, true);
    assert.match(cleared.message, /removed secure credentials/i);

    const afterClear = await listConfiguredServices(workspaceDir);
    assert.deepEqual(afterClear, []);
  });
});
