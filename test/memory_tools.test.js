import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

import {
  createMemoryGetTool,
  createMemorySaveTool,
  createMemorySearchTool,
} from "../src/agents/tools/memory-tools.ts";

async function createWorkspaceFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "t560-memory-test-"));
  const workspaceDir = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  return {
    root,
    workspaceDir,
    env: {
      ...process.env,
      T560_STATE_DIR: stateDir,
    },
  };
}

test("memory_save + memory_search + memory_get round-trip stored memory", async () => {
  const fixture = await createWorkspaceFixture();
  const memorySave = createMemorySaveTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });
  const memorySearch = createMemorySearchTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });
  const memoryGet = createMemoryGetTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });

  try {
    const saved = await memorySave.execute("mem-save-1", {
      title: "Food preference",
      content: "User prefers thin-crust pizza over deep-dish options.",
      tags: ["preferences", "food"],
    });
    assert.equal(saved.ok, true);
    assert.match(String(saved.ref), /^store:/);

    const searched = await memorySearch.execute("mem-search-1", {
      query: "thin crust pizza preference",
      limit: 5,
    });
    assert.equal(Array.isArray(searched.results), true);
    assert.ok(searched.results.length > 0);
    const top = searched.results[0];
    assert.equal(top.kind, "store");
    assert.match(String(top.ref), /^store:/);

    const fetched = await memoryGet.execute("mem-get-1", {
      ref: top.ref,
    });
    assert.equal(fetched.source, "store");
    assert.match(String(fetched.content), /thin-crust pizza/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("memory_search indexes MEMORY.md and memory/*.md, and memory_get returns exact lines", async () => {
  const fixture = await createWorkspaceFixture();
  const memoryDir = path.join(fixture.workspaceDir, "memory");
  await mkdir(memoryDir, { recursive: true });
  await writeFile(
    path.join(fixture.workspaceDir, "MEMORY.md"),
    "# MEMORY\n\nFavorite broker dashboard: Haven Vaults.\n",
    "utf-8",
  );
  await writeFile(
    path.join(memoryDir, "sites.md"),
    "# Sites\n\nHaven Vaults login uses one-time codes sent to email.\n",
    "utf-8",
  );

  const memorySearch = createMemorySearchTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });
  const memoryGet = createMemoryGetTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });

  try {
    const searched = await memorySearch.execute("mem-search-files-1", {
      query: "haven vaults one-time codes",
      limit: 10,
      includeStore: false,
      includeFiles: true,
    });
    assert.ok(searched.results.length > 0);
    const fileHit = searched.results.find((row) => row.kind === "file");
    assert.ok(fileHit);
    assert.match(String(fileHit.path), /memory/i);
    assert.match(String(fileHit.ref), /^file:/);

    const fetched = await memoryGet.execute("mem-get-files-1", {
      ref: fileHit.ref,
      contextLines: 1,
    });
    assert.equal(fetched.source, "file");
    assert.match(String(fetched.content), /Haven Vaults login uses one-time codes/i);
    assert.match(String(fetched.ref), /^file:/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("memory_save rejects likely secret material", async () => {
  const fixture = await createWorkspaceFixture();
  const memorySave = createMemorySaveTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });
  try {
    await assert.rejects(
      () =>
        memorySave.execute("mem-save-secret-1", {
          title: "Do not store this",
          content: "Password token: sk_abcdefghijklmnopqrstuvwxyz123456",
          tags: ["secret"],
        }),
      /blocked: suspected secret/i,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
