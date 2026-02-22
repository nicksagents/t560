import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFilesystemTools } from "../src/agents/tools/fs-tools.ts";
import { commandTouchesSensitivePath } from "../src/security/credentials-vault.js";

function toolByName(tools, name) {
  const match = tools.find((tool) => tool.name === name);
  if (!match) {
    throw new Error(`Missing tool ${name}`);
  }
  return match;
}

test("filesystem tools block .env and vault paths", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "t560-fs-"));
  await writeFile(path.join(workspaceDir, ".env"), "PASSWORD=secret\n", "utf-8");
  await mkdir(path.join(workspaceDir, ".t560-secure"), { recursive: true });
  await writeFile(
    path.join(workspaceDir, ".t560-secure", "credentials.v1.enc"),
    "encrypted-payload",
    "utf-8",
  );
  await writeFile(path.join(workspaceDir, "safe.txt"), "ok", "utf-8");

  const tools = createFilesystemTools({ workspaceDir, workspaceOnly: true });
  const read = toolByName(tools, "read");
  const ls = toolByName(tools, "ls");
  const find = toolByName(tools, "find");

  await assert.rejects(
    () => read.execute("read-env", { path: ".env" }),
    /Access to sensitive credential files is blocked/i,
  );
  await assert.rejects(
    () => read.execute("read-vault", { path: ".t560-secure/credentials.v1.enc" }),
    /Access to sensitive credential files is blocked/i,
  );

  const listed = await ls.execute("ls-root", { path: ".", includeHidden: true });
  const names = listed.items.map((item) => item.name);
  assert.equal(names.includes(".env"), false);
  assert.equal(names.includes(".t560-secure"), false);
  assert.equal(names.includes("safe.txt"), true);

  const searched = await find.execute("find-root", { path: ".", pattern: "", limit: 50 });
  const filesText = searched.files.join("\n");
  assert.equal(filesText.includes(".env"), false);
  assert.equal(filesText.includes(".t560-secure"), false);
  assert.equal(filesText.includes("safe.txt"), true);
});

test("sensitive command detection flags direct env and vault access", () => {
  assert.equal(commandTouchesSensitivePath("cat .env"), true);
  assert.equal(commandTouchesSensitivePath("grep TOKEN .env.local"), true);
  assert.equal(commandTouchesSensitivePath("cat .t560-secure/credentials.v1.enc"), true);
  assert.equal(commandTouchesSensitivePath("ls -la"), false);
});
