import test from "node:test";
import assert from "node:assert/strict";

import { createBrowserTool } from "../src/agents/tools/browser-tool.ts";

test("browser tool can open, snapshot, click, and navigate history", async () => {
  const tool = createBrowserTool();
  const originalFetch = global.fetch;

  global.fetch = async (input) => {
    const url = String(input ?? "");
    if (url.includes("example.com/start")) {
      return new Response(
        `
          <html>
            <head><title>Start Page</title></head>
            <body>
              <h1>Start</h1>
              <a href="https://example.com/next">Next Page</a>
            </body>
          </html>
        `,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (url.includes("example.com/next")) {
      return new Response(
        `
          <html>
            <head><title>Next Page</title></head>
            <body>
              <h1>Next</h1>
            </body>
          </html>
        `,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  };

  try {
    await tool.execute("reset-1", { action: "reset" });

    const opened = await tool.execute("open-1", {
      action: "open",
      url: "https://example.com/start",
      snapshotAfter: true,
    });
    assert.equal(opened.ok, true);
    assert.equal(opened.snapshot.title, "Start Page");
    assert.equal(opened.snapshot.links.length, 1);

    const clicked = await tool.execute("click-1", {
      action: "click",
      tabId: opened.tab.id,
      linkIndex: 1,
      snapshotAfter: true,
    });
    assert.equal(clicked.ok, true);
    assert.equal(clicked.snapshot.title, "Next Page");
    assert.match(clicked.snapshot.url, /example\.com\/next/);

    const movedBack = await tool.execute("back-1", {
      action: "back",
      tabId: opened.tab.id,
      snapshotAfter: true,
    });
    assert.equal(movedBack.ok, true);
    assert.equal(movedBack.moved, true);
    assert.match(movedBack.snapshot.url, /example\.com\/start/);

    const movedForward = await tool.execute("fwd-1", {
      action: "forward",
      tabId: opened.tab.id,
      snapshotAfter: true,
    });
    assert.equal(movedForward.ok, true);
    assert.equal(movedForward.moved, true);
    assert.match(movedForward.snapshot.url, /example\.com\/next/);

    await tool.execute("back-2", {
      action: "back",
      tabId: opened.tab.id,
      snapshotAfter: true,
    });

    const acted = await tool.execute("act-1", {
      action: "act",
      tabId: opened.tab.id,
      linkIndex: 1,
      snapshotAfter: true,
    });
    assert.equal(acted.ok, true);
    assert.match(acted.snapshot.url, /example\.com\/next/);

    const reloaded = await tool.execute("reload-1", {
      action: "reload",
      tabId: opened.tab.id,
      snapshotAfter: true,
    });
    assert.equal(reloaded.ok, true);
    assert.match(reloaded.snapshot.url, /example\.com\/next/);
  } finally {
    global.fetch = originalFetch;
  }
});
