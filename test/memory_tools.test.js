import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import {
  createMemoryCompactTool,
  createMemoryDeleteTool,
  createMemoryFeedbackTool,
  createMemoryGetTool,
  createMemoryListTool,
  createMemoryPruneTool,
  createMemorySaveTool,
  createMemorySearchTool,
  createMemoryStatsTool,
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

test("memory_search and memory_get can resolve newest entries beyond store scan cap", async () => {
  const fixture = await createWorkspaceFixture();
  const storePath = path.join(fixture.env.T560_STATE_DIR, "memory.jsonl");
  const now = Date.now();
  const rows = [];
  for (let i = 0; i < 2105; i += 1) {
    rows.push(
      JSON.stringify({
        id: `entry-${i}`,
        title: `Entry ${i}`,
        content: i === 2104 ? "needle-most-recent-entry" : `filler-${i}`,
        tags: ["test"],
        createdAt: new Date(now - (2105 - i) * 1000).toISOString(),
        updatedAt: new Date(now - (2105 - i) * 1000).toISOString(),
      }),
    );
  }
  await writeFile(storePath, `${rows.join("\n")}\n`, "utf-8");

  const memorySearch = createMemorySearchTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });
  const memoryGet = createMemoryGetTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });

  try {
    const searched = await memorySearch.execute("mem-search-cap-1", {
      query: "needle-most-recent-entry",
      includeFiles: false,
      includeStore: true,
      limit: 5,
    });
    assert.ok(searched.results.length > 0);
    const top = searched.results[0];
    assert.equal(top.kind, "store");
    assert.equal(String(top.id), "entry-2104");

    const fetched = await memoryGet.execute("mem-get-cap-1", {
      id: "entry-2104",
    });
    assert.equal(fetched.source, "store");
    assert.match(String(fetched.content), /needle-most-recent-entry/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("memory_search indexes surrounding context files and memory_get can read them", async () => {
  const fixture = await createWorkspaceFixture();
  await writeFile(
    path.join(fixture.workspaceDir, "AGENTS.md"),
    "# Agent Guide\n\nPrimary operator codename: Kenkniw.\n",
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
    const searched = await memorySearch.execute("mem-search-surrounding-1", {
      query: "kenkniw codename",
      includeStore: false,
      includeFiles: true,
      includeSurrounding: true,
      limit: 5,
    });
    assert.ok(searched.results.length > 0);
    const fileHit = searched.results.find((row) => row.kind === "file" && String(row.path) === "AGENTS.md");
    assert.ok(fileHit);

    const fetched = await memoryGet.execute("mem-get-surrounding-1", {
      ref: fileHit.ref,
      contextLines: 1,
    });
    assert.equal(fetched.source, "file");
    assert.equal(String(fetched.path), "AGENTS.md");
    assert.match(String(fetched.content), /Kenkniw/i);
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
    await assert.rejects(
      () =>
        memorySave.execute("mem-save-secret-2", {
          title: "github token",
          content: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
          tags: ["secret"],
        }),
      /blocked: suspected secret/i,
    );
    await assert.rejects(
      () =>
        memorySave.execute("mem-save-secret-3", {
          title: "aws key",
          content: "AKIAIOSFODNN7EXAMPLE",
          tags: ["secret"],
        }),
      /blocked: suspected secret/i,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("memory_save upserts similar entries instead of creating duplicates", async () => {
  const fixture = await createWorkspaceFixture();
  const memorySave = createMemorySaveTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });
  const memorySearch = createMemorySearchTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });
  try {
    const first = await memorySave.execute("mem-upsert-1", {
      title: "Editor Preference",
      content: "User prefers vim keybindings.",
      tags: ["preference"],
    });
    const second = await memorySave.execute("mem-upsert-2", {
      title: "editor preference",
      content: "User prefers vim keybindings and terse diffs.",
      tags: ["preferences", "workflow"],
    });

    assert.equal(first.id, second.id);
    assert.equal(second.upserted, true);

    const searched = await memorySearch.execute("mem-upsert-search", {
      query: "vim keybindings terse diffs",
      includeFiles: false,
      includeStore: true,
      limit: 10,
    });
    const matching = searched.results.filter((row) => row.kind === "store" && row.id === second.id);
    assert.equal(matching.length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("memory_search ranking prefers higher-importance entries and exposes metadata", async () => {
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
    const low = await memorySave.execute("mem-meta-low", {
      title: "Legacy deployment strategy",
      content: "deploycanarylowuniq1122",
      tags: ["deploy"],
      importance: 1,
      confidence: 0.6,
      source: "user",
    });
    const high = await memorySave.execute("mem-meta-high", {
      title: "Current deployment strategy",
      content: "deploycanaryhighuniq3344",
      tags: ["deploy"],
      importance: 5,
      confidence: 0.95,
      source: "user",
    });

    const searched = await memorySearch.execute("mem-meta-search", {
      query: "deploycanaryhighuniq3344 deploycanarylowuniq1122",
      includeFiles: false,
      includeStore: true,
      limit: 5,
    });
    assert.ok(searched.results.length > 0);
    assert.equal(String(searched.results[0]?.id), String(high.id));
    assert.equal(Number(searched.results[0]?.importance), 5);

    const fetched = await memoryGet.execute("mem-meta-get", { id: high.id });
    assert.equal(Number(fetched.importance), 5);
    assert.equal(Number(fetched.confidence) >= 0.9, true);
    assert.equal(String(fetched.memorySource), "user");
    assert.equal(String(low.id) === String(high.id), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("memory_search supports namespace and trust-tier isolation", async () => {
  const fixture = await createWorkspaceFixture();
  const memorySave = createMemorySaveTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });
  const memorySearch = createMemorySearchTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });

  try {
    await memorySave.execute("mem-scope-1", {
      title: "Billing rule",
      content: "Use enterprise annual billing for this account.",
      tags: ["billing"],
      namespace: "kenkniw",
      trustTier: "verified",
    });
    await memorySave.execute("mem-scope-2", {
      title: "Billing rule",
      content: "Use trial monthly billing for this account.",
      tags: ["billing"],
      namespace: "guest",
      trustTier: "verified",
    });
    await memorySave.execute("mem-scope-3", {
      title: "Draft billing note",
      content: "Potential billing change, still unconfirmed.",
      tags: ["billing"],
      namespace: "kenkniw",
      trustTier: "unverified",
    });

    const kenkniwOnly = await memorySearch.execute("mem-scope-search-1", {
      query: "billing account",
      includeFiles: false,
      includeStore: true,
      namespace: "kenkniw",
      minTrustTier: "verified",
      limit: 10,
    });
    assert.equal(
      kenkniwOnly.results.every((row) => row.kind !== "store" || row.namespace === "kenkniw"),
      true,
    );
    assert.equal(
      kenkniwOnly.results.some((row) => row.kind === "store" && String(row.trustTier) === "unverified"),
      false,
    );

    const guestOnly = await memorySearch.execute("mem-scope-search-2", {
      query: "billing account",
      includeFiles: false,
      includeStore: true,
      namespace: "guest",
      minTrustTier: "unverified",
      limit: 10,
    });
    assert.equal(
      guestOnly.results.every((row) => row.kind !== "store" || row.namespace === "guest"),
      true,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("memory_save surfaces contradictions and can replace conflicting memory", async () => {
  const fixture = await createWorkspaceFixture();
  const memorySave = createMemorySaveTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });
  const memoryGet = createMemoryGetTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });

  try {
    const first = await memorySave.execute("mem-conflict-first", {
      title: "Editor preference",
      content: "User prefers tabs for indentation.",
      tags: ["preference"],
    });
    const second = await memorySave.execute("mem-conflict-second", {
      title: "Editor preference",
      content: "User prefers spaces for indentation.",
      tags: ["preference"],
    });
    assert.equal(second.conflictDetected, true);
    assert.equal(Array.isArray(second.conflicts), true);
    assert.equal(second.conflicts.length > 0, true);
    assert.equal(String(second.conflictSuggestion).length > 0, true);

    const replaced = await memorySave.execute("mem-conflict-replace", {
      title: "Editor preference",
      content: "User prefers two-space indentation only.",
      tags: ["preference"],
      onConflict: "replace",
    });
    assert.equal(replaced.conflictDetected, true);
    assert.equal(Array.isArray(replaced.replacedIds), true);
    assert.equal(replaced.replacedIds.includes(first.id), true);

    await assert.rejects(
      () => memoryGet.execute("mem-conflict-old-get", { id: first.id }),
      /not found/i,
    );
    const current = await memoryGet.execute("mem-conflict-current-get", { id: replaced.id });
    assert.match(String(current.content), /two-space/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("memory_feedback reinforces ranking of useful memories", async () => {
  const fixture = await createWorkspaceFixture();
  const memorySave = createMemorySaveTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });
  const memorySearch = createMemorySearchTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });
  const memoryFeedback = createMemoryFeedbackTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });

  try {
    const first = await memorySave.execute("mem-feedback-save-1", {
      title: "Shipping note A",
      content: "shipping-priority-unique-token",
      tags: ["shipping"],
      importance: 3,
      confidence: 0.8,
    });
    const second = await memorySave.execute("mem-feedback-save-2", {
      title: "Shipping note B",
      content: "shipping-priority-unique-token",
      tags: ["shipping"],
      importance: 3,
      confidence: 0.8,
    });

    await memoryFeedback.execute("mem-feedback-apply", {
      id: second.id,
      signal: "useful",
      weight: 3,
    });

    const searched = await memorySearch.execute("mem-feedback-search", {
      query: "shipping-priority-unique-token",
      includeFiles: false,
      includeStore: true,
      limit: 5,
    });
    assert.equal(String(searched.results[0]?.id), String(second.id));

    await memoryFeedback.execute("mem-feedback-demote", {
      id: second.id,
      signal: "not_useful",
      weight: 3,
    });

    const searchedAfterDemote = await memorySearch.execute("mem-feedback-search-2", {
      query: "shipping-priority-unique-token",
      includeFiles: false,
      includeStore: true,
      limit: 5,
    });
    assert.equal(
      [String(first.id), String(second.id)].includes(String(searchedAfterDemote.results[0]?.id)),
      true,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("memory_delete removes store entries from search and get", async () => {
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
  const memoryDelete = createMemoryDeleteTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });

  try {
    const saved = await memorySave.execute("mem-delete-save", {
      title: "Deprecated preference",
      content: "User likes tabs for indentation.",
      tags: ["preference"],
    });
    const deleted = await memoryDelete.execute("mem-delete-run", {
      ref: saved.ref,
      reason: "User switched to spaces",
    });
    assert.equal(deleted.ok, true);
    assert.equal(deleted.deleted, true);
    assert.equal(String(deleted.id), String(saved.id));

    const searched = await memorySearch.execute("mem-delete-search", {
      query: "tabs indentation preference",
      includeFiles: false,
      includeStore: true,
      limit: 10,
    });
    assert.equal(
      searched.results.some((row) => row.kind === "store" && String(row.id) === String(saved.id)),
      false,
    );

    await assert.rejects(
      () =>
        memoryGet.execute("mem-delete-get", {
          id: saved.id,
        }),
      /not found/i,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("memory_list supports tag filtering and optional content payload", async () => {
  const fixture = await createWorkspaceFixture();
  const memorySave = createMemorySaveTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });
  const memoryList = createMemoryListTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });

  try {
    await memorySave.execute("mem-list-save-1", {
      title: "Workflow preference",
      content: "User prefers short progress updates with concrete file paths.",
      tags: ["workflow", "preference"],
    });
    await memorySave.execute("mem-list-save-2", {
      title: "Food preference",
      content: "User prefers spicy ramen.",
      tags: ["food", "preference"],
    });

    const filtered = await memoryList.execute("mem-list-1", {
      tags: ["workflow"],
      limit: 10,
      includeContent: false,
      order: "updated_desc",
    });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.results.length, 1);
    assert.equal(String(filtered.results[0]?.title), "Workflow preference");
    assert.equal("content" in filtered.results[0], false);

    const withContent = await memoryList.execute("mem-list-2", {
      tags: ["workflow"],
      includeContent: true,
      maxContentChars: 220,
    });
    assert.equal(withContent.total, 1);
    assert.match(String(withContent.results[0]?.content), /short progress updates/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("memory_prune supports dry-run preview and applies age-based retention", async () => {
  const fixture = await createWorkspaceFixture();
  const storePath = path.join(fixture.env.T560_STATE_DIR, "memory.jsonl");
  const now = Date.now();
  const rows = [
    {
      id: "old-1",
      title: "Legacy alpha",
      content: "legacyalphauniq314159",
      tags: ["legacy"],
      createdAt: new Date(now - 120 * 86_400_000).toISOString(),
      updatedAt: new Date(now - 120 * 86_400_000).toISOString(),
    },
    {
      id: "old-2",
      title: "Legacy beta",
      content: "legacybetauniq271828",
      tags: ["legacy"],
      createdAt: new Date(now - 45 * 86_400_000).toISOString(),
      updatedAt: new Date(now - 45 * 86_400_000).toISOString(),
    },
    {
      id: "new-1",
      title: "Current gamma",
      content: "currentgammauniq161803",
      tags: ["current"],
      createdAt: new Date(now - 2 * 86_400_000).toISOString(),
      updatedAt: new Date(now - 2 * 86_400_000).toISOString(),
    },
  ];
  await writeFile(storePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf-8");

  const memoryPrune = createMemoryPruneTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });
  const memorySearch = createMemorySearchTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });

  try {
    const preview = await memoryPrune.execute("mem-prune-dry-run", {
      olderThanDays: 30,
      dryRun: true,
      reason: "Retention test",
    });
    assert.equal(preview.ok, true);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.wouldPrune, 2);
    assert.equal(preview.pruned, 0);

    const applied = await memoryPrune.execute("mem-prune-apply", {
      olderThanDays: 30,
      dryRun: false,
      reason: "Retention test",
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.dryRun, false);
    assert.equal(applied.pruned, 2);

    const oldSearch = await memorySearch.execute("mem-prune-search-old", {
      query: "legacyalphauniq314159",
      includeFiles: false,
      includeStore: true,
      limit: 5,
    });
    assert.equal(oldSearch.results.length, 0);

    const newSearch = await memorySearch.execute("mem-prune-search-new", {
      query: "currentgammauniq161803",
      includeFiles: false,
      includeStore: true,
      limit: 5,
    });
    assert.equal(newSearch.results.length > 0, true);
    assert.equal(String(newSearch.results[0]?.id), "new-1");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("memory_compact rewrites store to active entries only", async () => {
  const fixture = await createWorkspaceFixture();
  const storePath = path.join(fixture.env.T560_STATE_DIR, "memory.jsonl");
  const now = Date.now();
  const rows = [
    {
      id: "a",
      title: "Alpha preference",
      content: "alpha v1",
      tags: ["pref"],
      createdAt: new Date(now - 100_000).toISOString(),
      updatedAt: new Date(now - 100_000).toISOString(),
      importance: 2,
      confidence: 0.7,
      source: "user",
    },
    {
      id: "a",
      title: "Alpha preference",
      content: "alpha v2",
      tags: ["pref"],
      createdAt: new Date(now - 100_000).toISOString(),
      updatedAt: new Date(now - 50_000).toISOString(),
      importance: 4,
      confidence: 0.9,
      source: "user",
    },
    {
      id: "b",
      title: "Beta preference",
      content: "betacompactuniq777",
      tags: ["pref"],
      createdAt: new Date(now - 90_000).toISOString(),
      updatedAt: new Date(now - 90_000).toISOString(),
      importance: 3,
      confidence: 0.8,
      source: "user",
    },
    {
      type: "delete",
      id: "b",
      deletedAt: new Date(now - 10_000).toISOString(),
      reason: "stale",
    },
    {
      id: "c",
      title: "Gamma preference",
      content: "gammacompactuniq888",
      tags: ["pref"],
      createdAt: new Date(now - 40_000).toISOString(),
      updatedAt: new Date(now - 40_000).toISOString(),
      importance: 3,
      confidence: 0.8,
      source: "user",
    },
  ];
  await writeFile(storePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf-8");

  const memoryCompact = createMemoryCompactTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });
  const memorySearch = createMemorySearchTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });

  try {
    const preview = await memoryCompact.execute("mem-compact-preview", { dryRun: true });
    assert.equal(preview.ok, true);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.linesBefore, 5);
    assert.equal(preview.linesAfter, 2);
    assert.equal(preview.reclaimedLines, 3);

    const applied = await memoryCompact.execute("mem-compact-apply", { dryRun: false });
    assert.equal(applied.ok, true);
    assert.equal(applied.dryRun, false);
    assert.equal(applied.linesAfter, 2);

    const compactedRaw = await readFile(storePath, "utf-8");
    const compactedLines = compactedRaw.split("\n").filter((line) => line.trim().length > 0);
    assert.equal(compactedLines.length, 2);

    const removed = await memorySearch.execute("mem-compact-removed", {
      query: "betacompactuniq777",
      includeFiles: false,
      includeStore: true,
      limit: 3,
    });
    assert.equal(removed.results.length, 0);

    const kept = await memorySearch.execute("mem-compact-kept", {
      query: "gammacompactuniq888",
      includeFiles: false,
      includeStore: true,
      limit: 3,
    });
    assert.equal(kept.results.length > 0, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("memory_search semantic retrieval handles related wording", async () => {
  const fixture = await createWorkspaceFixture();
  const memorySave = createMemorySaveTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });
  const memorySearch = createMemorySearchTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });

  try {
    const saved = await memorySave.execute("mem-semantic-save", {
      title: "Automation workflow",
      content: "We are automating deployment workflow checks.",
      tags: ["automation"],
    });

    const searched = await memorySearch.execute("mem-semantic-search", {
      query: "automation deploy pipeline",
      includeFiles: false,
      includeStore: true,
      limit: 5,
    });
    assert.equal(String(searched.results[0]?.id), String(saved.id));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("memory_stats reports namespace and trust-tier analytics", async () => {
  const fixture = await createWorkspaceFixture();
  const memorySave = createMemorySaveTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });
  const memoryStats = createMemoryStatsTool({
    workspaceDir: fixture.workspaceDir,
    env: fixture.env,
  });

  try {
    await memorySave.execute("mem-stats-save-1", {
      title: "Ops preference",
      content: "Use deterministic deploy workflows.",
      tags: ["ops"],
      namespace: "kenkniw",
      trustTier: "verified",
      importance: 4,
      confidence: 0.9,
    });
    await memorySave.execute("mem-stats-save-2", {
      title: "Draft note",
      content: "Potential infra update, pending confirmation.",
      tags: ["ops"],
      namespace: "kenkniw",
      trustTier: "unverified",
      importance: 2,
      confidence: 0.5,
    });
    await memorySave.execute("mem-stats-save-3", {
      title: "Guest preference",
      content: "Use concise summaries.",
      tags: ["workflow"],
      namespace: "guest",
      trustTier: "observed",
      importance: 3,
      confidence: 0.8,
    });

    const globalStats = await memoryStats.execute("mem-stats-global", {
      includeStaleCandidates: true,
      staleLimit: 5,
      limitNamespaces: 10,
      minTrustTier: "unverified",
    });
    assert.equal(globalStats.ok, true);
    assert.equal(globalStats.totals.activeEntries >= 3, true);
    assert.equal(globalStats.namespaces.length >= 2, true);

    const verifiedOnly = await memoryStats.execute("mem-stats-filtered", {
      namespace: "kenkniw",
      minTrustTier: "verified",
      includeStaleCandidates: false,
      staleLimit: 5,
      limitNamespaces: 10,
    });
    assert.equal(verifiedOnly.filters.namespace, "kenkniw");
    assert.equal(verifiedOnly.totals.filteredEntries >= 1, true);
    assert.equal(
      verifiedOnly.namespaces.every((row) => row.namespace === "kenkniw"),
      true,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("memory_save enforces namespace quota eviction policy", async () => {
  const fixture = await createWorkspaceFixture();
  const quotaEnv = {
    ...fixture.env,
    T560_MEMORY_NAMESPACE_LIMITS: JSON.stringify({
      kenkniw: {
        maxEntries: 2,
        maxBytes: 100000,
        evictionPolicy: "oldest",
      },
    }),
  };
  const memorySave = createMemorySaveTool({
    workspaceDir: fixture.workspaceDir,
    env: quotaEnv,
  });
  const memorySearch = createMemorySearchTool({
    workspaceDir: fixture.workspaceDir,
    env: quotaEnv,
  });

  try {
    const first = await memorySave.execute("mem-quota-1", {
      title: "Quota first",
      content: "quotaoldestuniq111",
      tags: ["quota"],
      namespace: "kenkniw",
      trustTier: "verified",
    });
    await memorySave.execute("mem-quota-2", {
      title: "Quota second",
      content: "quotamiddleuniq222",
      tags: ["quota"],
      namespace: "kenkniw",
      trustTier: "verified",
    });
    const third = await memorySave.execute("mem-quota-3", {
      title: "Quota third",
      content: "quotanewuniq333",
      tags: ["quota"],
      namespace: "kenkniw",
      trustTier: "verified",
    });

    assert.equal(Array.isArray(third.evictedIds), true);
    assert.equal(third.evictedIds.includes(first.id), true);

    const removed = await memorySearch.execute("mem-quota-search-removed", {
      query: "quotaoldestuniq111",
      includeFiles: false,
      includeStore: true,
      namespace: "kenkniw",
      minTrustTier: "unverified",
      limit: 5,
    });
    assert.equal(removed.results.length, 0);

    const kept = await memorySearch.execute("mem-quota-search-kept", {
      query: "quotanewuniq333",
      includeFiles: false,
      includeStore: true,
      namespace: "kenkniw",
      minTrustTier: "unverified",
      limit: 5,
    });
    assert.equal(kept.results.length > 0, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
