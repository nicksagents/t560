import test from "node:test";
import assert from "node:assert/strict";

import { createBrowserTool } from "../src/agents/tools/browser-tool.ts";

test("browser supports t560 start/stop/profiles actions", async () => {
  const tool = createBrowserTool();

  await tool.execute("t560-reset-1", { action: "reset" });

  const status = await tool.execute("t560-status-1", { action: "status" });
  assert.equal(status.ok, true);
  assert.ok(Array.isArray(status.capabilities));
  assert.ok(status.capabilities.includes("start"));
  assert.ok(status.capabilities.includes("stop"));
  assert.ok(status.capabilities.includes("profiles"));
  assert.ok(status.capabilities.includes("login"));
  assert.ok(status.capabilities.includes("mfa"));

  const profiles = await tool.execute("t560-profiles-1", { action: "profiles" });
  assert.equal(profiles.ok, true);
  assert.ok(Array.isArray(profiles.profiles));
  assert.equal(profiles.profiles[0].id, "default");

  const started = await tool.execute("t560-start-1", { action: "start", profile: "chrome" });
  assert.equal(started.ok, true);
  assert.equal(started.started, true);

  const stopped = await tool.execute("t560-stop-1", { action: "stop", profile: "chrome" });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopped, true);
});

test("browser honors t560 target defaults and host/sandbox policy checks", async () => {
  const sandboxTool = createBrowserTool({
    sandboxBridgeUrl: "http://sandbox-bridge.local",
    allowHostControl: false,
  });

  const status = await sandboxTool.execute("t560-target-status-1", { action: "status" });
  assert.equal(status.ok, true);
  assert.equal(status.target, "sandbox");

  await assert.rejects(
    () =>
      sandboxTool.execute("t560-target-status-2", {
        action: "status",
        target: "host",
      }),
    /Host browser control is disabled by sandbox policy/,
  );

  const hostTool = createBrowserTool();
  await assert.rejects(
    () =>
      hostTool.execute("t560-target-status-3", {
        action: "status",
        target: "sandbox",
      }),
    /Sandbox browser is unavailable/,
  );

  await assert.rejects(
    () =>
      sandboxTool.execute("t560-target-act-1", {
        action: "act",
        request: {
          kind: "close",
          target: "host",
        },
      }),
    /Host browser control is disabled by sandbox policy/,
  );
});

test("browser supports targetUrl/targetId aliases and act.request click", async () => {
  const tool = createBrowserTool();
  const originalFetch = global.fetch;

  global.fetch = async (input) => {
    const url = String(input ?? "");
    if (url.includes("example.com/start")) {
      return new Response(
        `
          <html>
            <head><title>Alias Start</title></head>
            <body>
              <a href="https://example.com/next">Next Via Ref</a>
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
            <head><title>Alias Next</title></head>
            <body>done</body>
          </html>
        `,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  };

  try {
    await tool.execute("t560-reset-2", { action: "reset" });

    const opened = await tool.execute("t560-open-1", {
      action: "open",
      targetUrl: "https://example.com/start",
      snapshotAfter: true,
    });
    assert.equal(opened.ok, true);
    assert.equal(opened.snapshot.title, "Alias Start");

    const snap = await tool.execute("t560-snap-1", {
      action: "snapshot",
      targetId: opened.tab.id,
      snapshotFormat: "aria",
      refs: "aria",
      mode: "efficient",
      compact: true,
      interactive: true,
      depth: 2,
    });
    assert.equal(snap.ok, true);
    const linkRef = snap.refs.find((entry) => entry.kind === "link");
    assert.ok(linkRef, "expected a link ref");

    const acted = await tool.execute("t560-act-click-1", {
      action: "act",
      request: {
        kind: "click",
        targetId: opened.tab.id,
        ref: linkRef.ref,
      },
      snapshotAfter: true,
    });
    assert.equal(acted.ok, true);
    assert.equal(acted.kind, "click");
    assert.equal(acted.snapshot.title, "Alias Next");

    const closed = await tool.execute("t560-close-1", {
      action: "close",
      targetId: opened.tab.id,
    });
    assert.equal(closed.ok, true);
    assert.equal(closed.closedTabId, opened.tab.id);
  } finally {
    global.fetch = originalFetch;
  }
});

test("browser supports act.request inputRef alias for ref-based actions", async () => {
  const tool = createBrowserTool();
  const originalFetch = global.fetch;

  global.fetch = async (input) => {
    const url = String(input ?? "");
    if (url.includes("example.com/inputref-start")) {
      return new Response(
        `
          <html>
            <head><title>InputRef Start</title></head>
            <body>
              <a href="https://example.com/inputref-next">InputRef Link</a>
            </body>
          </html>
        `,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (url.includes("example.com/inputref-next")) {
      return new Response(
        `
          <html>
            <head><title>InputRef Next</title></head>
            <body>done</body>
          </html>
        `,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  };

  try {
    await tool.execute("t560-reset-5", { action: "reset" });

    const opened = await tool.execute("t560-open-5", {
      action: "open",
      targetUrl: "https://example.com/inputref-start",
      snapshotAfter: true,
    });
    const linkRef = opened.snapshot.refs.find((entry) => entry.kind === "link");
    assert.ok(linkRef, "expected a link ref");

    const acted = await tool.execute("t560-act-click-5", {
      action: "act",
      request: {
        kind: "click",
        targetId: opened.tab.id,
        inputRef: linkRef.ref,
      },
      snapshotAfter: true,
    });
    assert.equal(acted.ok, true);
    assert.equal(acted.kind, "click");
    assert.equal(acted.snapshot.title, "InputRef Next");
  } finally {
    global.fetch = originalFetch;
  }
});

test("browser supports snapshot from targetUrl and accepts t560 screenshot fields", async () => {
  const tool = createBrowserTool();
  const originalFetch = global.fetch;

  global.fetch = async (input) => {
    const url = String(input ?? "");
    if (url.includes("example.com/snap-url")) {
      return new Response(
        `
          <html>
            <head><title>Snapshot URL</title></head>
            <body><h1>Snap URL Page</h1></body>
          </html>
        `,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  };

  try {
    await tool.execute("t560-reset-4", { action: "reset" });

    const snapped = await tool.execute("t560-snap-2", {
      action: "snapshot",
      targetUrl: "https://example.com/snap-url",
      snapshotFormat: "aria",
      refs: "role",
      mode: "efficient",
      compact: true,
      interactive: true,
      depth: 1,
    });
    assert.equal(snapped.ok, true);
    assert.equal(snapped.snapshot.title, "Snapshot URL");

    const tabs = await tool.execute("t560-tabs-2", {
      action: "tabs",
      target: "host",
      profile: "chrome",
      labels: true,
      frame: "main",
      fullPage: true,
      type: "jpeg",
    });
    assert.equal(tabs.ok, true);
    assert.ok(Array.isArray(tabs.tabs));
  } finally {
    global.fetch = originalFetch;
  }
});

test("browser supports act.request fill fields batch", async () => {
  const tool = createBrowserTool();
  const originalFetch = global.fetch;

  global.fetch = async (input, init = {}) => {
    const url = String(input ?? "");
    const method = String(init?.method ?? "GET").toUpperCase();
    const body = init?.body == null ? "" : String(init.body);

    if (url === "https://example.com/login" && method === "GET") {
      return new Response(
        `
          <html>
            <head><title>Batch Form</title></head>
            <body>
              <form action="/session" method="post">
                <input type="text" name="username" />
                <input type="password" name="password" />
                <button type="submit">Sign In</button>
              </form>
            </body>
          </html>
        `,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    if (url === "https://example.com/session" && method === "POST") {
      assert.match(body, /username=alice/);
      assert.match(body, /password=swordfish/);
      return new Response(
        `
          <html>
            <head><title>Batch Done</title></head>
            <body>ok</body>
          </html>
        `,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  };

  try {
    await tool.execute("t560-reset-3", { action: "reset" });

    const opened = await tool.execute("t560-open-2", {
      action: "open",
      targetUrl: "https://example.com/login",
      snapshotAfter: true,
    });

    const filled = await tool.execute("t560-act-fill-1", {
      action: "act",
      request: {
        kind: "fill",
        targetId: opened.tab.id,
        formIndex: 1,
        fields: [
          { fieldName: "username", value: "alice" },
          { fieldName: "password", value: "swordfish" },
        ],
      },
    });
    assert.equal(filled.ok, true);
    assert.equal(filled.kind, "fill");
    assert.equal(filled.batch, true);
    assert.equal(filled.filled, 2);

    const submitted = await tool.execute("t560-act-submit-1", {
      action: "act",
      request: {
        kind: "submit",
        targetId: opened.tab.id,
        formIndex: 1,
      },
    });
    assert.equal(submitted.ok, true);
    assert.equal(submitted.kind, "submit");
    assert.equal(submitted.snapshot.title, "Batch Done");
  } finally {
    global.fetch = originalFetch;
  }
});
