import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { createEmailTool } from "../src/agents/tools/email-tool.ts";
import { setCredential } from "../src/security/credentials-vault.js";

async function withTempHome(fn) {
  const previousHome = process.env.HOME;
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "t560-email-home-"));
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

async function startMockImapServer() {
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("* OK Mock IMAP Ready\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const idx = buffer.indexOf("\r\n");
        if (idx < 0) {
          break;
        }
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const match = line.match(/^([A-Z0-9]+)\s+(.+)$/i);
        if (!match) {
          continue;
        }
        const tag = match[1];
        const command = match[2].toUpperCase();

        if (command.startsWith("LOGIN ")) {
          socket.write(`${tag} OK LOGIN completed\r\n`);
          continue;
        }
        if (command.startsWith("SELECT ")) {
          socket.write("* 1 EXISTS\r\n");
          socket.write(`${tag} OK SELECT completed\r\n`);
          continue;
        }
        if (command.startsWith("SEARCH ")) {
          socket.write("* SEARCH 1\r\n");
          socket.write(`${tag} OK SEARCH completed\r\n`);
          continue;
        }
        if (command.startsWith("FETCH ")) {
          const headers = [
            "Subject: Inbox Test",
            "From: Sender <sender@example.com>",
            "To: user@example.com",
            "Date: Mon, 23 Feb 2026 17:00:00 +0000",
            "Message-ID: <m1@example.com>",
            "",
            "",
          ].join("\r\n");
          const literalLength = Buffer.byteLength(headers, "utf8");
          socket.write(
            `* 1 FETCH (UID 10 FLAGS () INTERNALDATE "23-Feb-2026 17:00:00 +0000" RFC822.SIZE 321 BODY[HEADER.FIELDS (SUBJECT FROM TO DATE MESSAGE-ID IN-REPLY-TO REFERENCES)] {${literalLength}}\r\n${headers}\r\n)\r\n${tag} OK FETCH completed\r\n`,
          );
          continue;
        }
        if (command.startsWith("LOGOUT")) {
          socket.write("* BYE logging out\r\n");
          socket.write(`${tag} OK LOGOUT completed\r\n`);
          socket.end();
          continue;
        }
        socket.write(`${tag} BAD unsupported\r\n`);
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Mock IMAP failed to bind.");
  }
  return {
    server,
    host: "127.0.0.1",
    port: addr.port,
    close: async () =>
      await new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function startMockSmtpServer() {
  let dataPayload = "";
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("220 mock.smtp ESMTP\r\n");
    let buffer = "";
    let mode = "command";
    let authStage = 0;

    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        if (mode === "data") {
          const endIdx = buffer.indexOf("\r\n.\r\n");
          if (endIdx < 0) {
            break;
          }
          dataPayload = buffer.slice(0, endIdx);
          buffer = buffer.slice(endIdx + 5);
          mode = "command";
          socket.write("250 queued\r\n");
          continue;
        }

        const idx = buffer.indexOf("\r\n");
        if (idx < 0) {
          break;
        }
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const upper = line.toUpperCase();

        if (upper.startsWith("EHLO ")) {
          socket.write("250-mock.smtp\r\n250 AUTH LOGIN\r\n");
          continue;
        }
        if (upper === "AUTH LOGIN") {
          authStage = 1;
          socket.write("334 VXNlcm5hbWU6\r\n");
          continue;
        }
        if (authStage === 1) {
          authStage = 2;
          socket.write("334 UGFzc3dvcmQ6\r\n");
          continue;
        }
        if (authStage === 2) {
          authStage = 0;
          socket.write("235 authenticated\r\n");
          continue;
        }
        if (upper.startsWith("MAIL FROM:")) {
          socket.write("250 ok\r\n");
          continue;
        }
        if (upper.startsWith("RCPT TO:")) {
          socket.write("250 ok\r\n");
          continue;
        }
        if (upper === "DATA") {
          mode = "data";
          socket.write("354 end with <CRLF>.<CRLF>\r\n");
          continue;
        }
        if (upper === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
          continue;
        }
        socket.write("500 unsupported\r\n");
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Mock SMTP failed to bind.");
  }
  return {
    server,
    host: "127.0.0.1",
    port: addr.port,
    getDataPayload: () => dataPayload,
    close: async () =>
      await new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

test("email tool returns browser-login fallback for password_with_mfa credentials", async () => {
  await withTempHome(async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "t560-email-workspace-"));
    await setCredential({
      workspaceDir,
      service: "mail.google.com",
      identifier: "user@gmail.com",
      secret: "plain-password",
      authMode: "password_with_mfa",
      websiteUrl: "https://mail.google.com",
    });

    const tool = createEmailTool({ workspaceDir });
    const result = await tool.execute("email-fallback-1", {
      action: "list_unread",
      service: "mail.google.com",
    });

    assert.equal(result.ok, false);
    assert.equal(result.requiresBrowserLogin, true);
    assert.match(String(result.reason), /password_with_mfa/i);
  });
});

test("email tool can read unread inbox headers over IMAP", async () => {
  await withTempHome(async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "t560-email-workspace-"));
    await setCredential({
      workspaceDir,
      service: "mail.test",
      identifier: "user@example.com",
      secret: "app-password",
      authMode: "password",
      websiteUrl: "https://mail.example.com",
    });
    const imap = await startMockImapServer();
    try {
      const tool = createEmailTool({ workspaceDir });
      const result = await tool.execute("email-imap-1", {
        action: "list_unread",
        service: "mail.test",
        imapHost: imap.host,
        imapPort: imap.port,
        imapSecure: false,
        smtpHost: "127.0.0.1",
        smtpPort: 2525,
        smtpSecure: false,
        smtpStartTls: false,
      });

      assert.equal(result.ok, true);
      assert.equal(result.count, 1);
      assert.equal(Array.isArray(result.messages), true);
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].subject, "Inbox Test");
    } finally {
      await imap.close();
    }
  });
});

test("email tool can send a message over SMTP", async () => {
  await withTempHome(async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "t560-email-workspace-"));
    await setCredential({
      workspaceDir,
      service: "mail.test",
      identifier: "user@example.com",
      secret: "app-password",
      authMode: "password",
      websiteUrl: "https://mail.example.com",
    });
    const smtp = await startMockSmtpServer();
    try {
      const tool = createEmailTool({ workspaceDir });
      const result = await tool.execute("email-smtp-1", {
        action: "send",
        service: "mail.test",
        to: ["friend@example.com"],
        subject: "Hello",
        text: "Just testing send flow.",
        imapHost: "127.0.0.1",
        imapPort: 1143,
        imapSecure: false,
        smtpHost: smtp.host,
        smtpPort: smtp.port,
        smtpSecure: false,
        smtpStartTls: false,
      });

      assert.equal(result.ok, true);
      assert.equal(result.acceptedCount, 1);
      const payload = smtp.getDataPayload();
      assert.match(payload, /Subject: Hello/);
      assert.match(payload, /Just testing send flow\./);
    } finally {
      await smtp.close();
    }
  });
});
