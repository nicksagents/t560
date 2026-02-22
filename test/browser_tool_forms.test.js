import test from "node:test";
import assert from "node:assert/strict";

import { createBrowserTool } from "../src/agents/tools/browser-tool.ts";

function readHeader(headers, key) {
  if (!headers) {
    return "";
  }
  if (typeof headers.get === "function") {
    return String(headers.get(key) ?? "");
  }
  const wanted = String(key ?? "").toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (String(name).toLowerCase() === wanted) {
      return String(value ?? "");
    }
  }
  return "";
}

test("browser tool supports forms/fill/submit with cookie forwarding", async () => {
  const tool = createBrowserTool();
  const originalFetch = global.fetch;
  const requests = [];

  global.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input?.url ?? "");
    const method = String(init?.method ?? "GET").toUpperCase();
    const cookie = readHeader(init?.headers, "cookie");
    const body = init?.body == null ? "" : String(init.body);
    requests.push({ url, method, cookie, body });

    if (url === "https://example.com/login" && method === "GET") {
      return new Response(
        `
          <html>
            <head><title>Login</title></head>
            <body>
              <form action="/session" method="post">
                <input type="hidden" name="csrf" value="token-123" />
                <input type="text" name="username" />
                <input type="password" name="password" />
                <button type="submit">Sign In</button>
              </form>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "set-cookie": "sid=abc123; Path=/",
          },
        },
      );
    }

    if (url === "https://example.com/session" && method === "POST") {
      assert.match(cookie, /sid=abc123/);
      assert.match(body, /csrf=token-123/);
      assert.match(body, /username=alice/);
      assert.match(body, /password=swordfish/);
      return new Response(
        `
          <html>
            <head><title>Dashboard</title></head>
            <body>
              <h1>Welcome</h1>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "set-cookie": "auth=1; Path=/",
          },
        },
      );
    }

    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  };

  try {
    await tool.execute("reset-form-1", { action: "reset" });

    const opened = await tool.execute("open-form-1", {
      action: "open",
      url: "https://example.com/login",
      snapshotAfter: true,
    });
    assert.equal(opened.ok, true);
    assert.equal(opened.snapshot.title, "Login");

    const forms = await tool.execute("forms-1", {
      action: "forms",
      tabId: opened.tab.id,
    });
    assert.equal(forms.ok, true);
    assert.equal(forms.forms.length, 1);
    assert.deepEqual(
      forms.forms[0].fields.map((field) => field.name),
      ["csrf", "username", "password"],
    );

    const fillUser = await tool.execute("fill-user-1", {
      action: "fill",
      tabId: opened.tab.id,
      formIndex: 1,
      fieldName: "username",
      value: "alice",
    });
    assert.equal(fillUser.ok, true);
    assert.equal(fillUser.value, "alice");

    const fillPass = await tool.execute("fill-pass-1", {
      action: "type",
      tabId: opened.tab.id,
      formIndex: 1,
      fieldName: "password",
      value: "swordfish",
    });
    assert.equal(fillPass.ok, true);
    assert.equal(fillPass.value, "swordfish");

    const submitted = await tool.execute("submit-1", {
      action: "submit",
      tabId: opened.tab.id,
      formIndex: 1,
    });
    assert.equal(submitted.ok, true);
    assert.equal(submitted.method, "post");
    assert.equal(submitted.snapshot.title, "Dashboard");
    assert.match(submitted.snapshot.url, /example\.com\/session/);

    const tabs = await tool.execute("tabs-form-1", { action: "tabs" });
    assert.equal(tabs.ok, true);
    assert.equal(tabs.tabs[0].cookieCount, 2);
    assert.equal(requests.filter((entry) => entry.method === "POST").length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("browser act supports fill+submit for GET forms", async () => {
  const tool = createBrowserTool();
  const originalFetch = global.fetch;

  global.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input?.url ?? "");
    const method = String(init?.method ?? "GET").toUpperCase();

    if (url === "https://example.com/search-form" && method === "GET") {
      return new Response(
        `
          <html>
            <head><title>Search Form</title></head>
            <body>
              <form action="/search" method="get">
                <input type="text" name="q" value="" />
              </form>
            </body>
          </html>
        `,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    if (url.includes("https://example.com/search?q=browser+tool") && method === "GET") {
      return new Response(
        `
          <html>
            <head><title>Search Results</title></head>
            <body>
              <h1>Results</h1>
            </body>
          </html>
        `,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  };

  try {
    await tool.execute("reset-form-2", { action: "reset" });
    const opened = await tool.execute("open-form-2", {
      action: "open",
      url: "https://example.com/search-form",
      snapshotAfter: true,
    });

    const actedFill = await tool.execute("act-fill-2", {
      action: "act",
      kind: "fill",
      tabId: opened.tab.id,
      formIndex: 1,
      fieldName: "q",
      value: "browser tool",
    });
    assert.equal(actedFill.ok, true);

    const actedSubmit = await tool.execute("act-submit-2", {
      action: "act",
      kind: "submit",
      tabId: opened.tab.id,
      formIndex: 1,
    });
    assert.equal(actedSubmit.ok, true);
    assert.equal(actedSubmit.kind, "submit");
    assert.equal(actedSubmit.snapshot.title, "Search Results");
    assert.match(actedSubmit.snapshot.url, /q=browser\+tool/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("browser snapshot refs support fill and click-submit by ref", async () => {
  const tool = createBrowserTool();
  const originalFetch = global.fetch;

  global.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input?.url ?? "");
    const method = String(init?.method ?? "GET").toUpperCase();
    const body = init?.body == null ? "" : String(init.body);

    if (url === "https://example.com/ref-form" && method === "GET") {
      return new Response(
        `
          <html>
            <head><title>Ref Form</title></head>
            <body>
              <form action="/ref-submit" method="post">
                <input type="text" name="email" value="" />
                <button type="submit">Continue</button>
              </form>
            </body>
          </html>
        `,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    if (url === "https://example.com/ref-submit" && method === "POST") {
      assert.match(body, /email=user%40example\.com/);
      return new Response(
        `
          <html>
            <head><title>Submitted</title></head>
            <body>Done</body>
          </html>
        `,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  };

  try {
    await tool.execute("reset-form-3", { action: "reset" });
    const opened = await tool.execute("open-form-3", {
      action: "open",
      url: "https://example.com/ref-form",
      snapshotAfter: true,
    });

    const snap = await tool.execute("snapshot-form-3", {
      action: "snapshot",
      tabId: opened.tab.id,
    });
    assert.equal(snap.ok, true);
    const fieldRef = snap.refs.find((entry) => entry.kind === "field" && entry.fieldName === "email");
    const submitRef = snap.refs.find((entry) => entry.kind === "submit");
    assert.ok(fieldRef, "expected field ref for email");
    assert.ok(submitRef, "expected submit ref");

    const filled = await tool.execute("fill-ref-3", {
      action: "fill",
      tabId: opened.tab.id,
      ref: fieldRef.ref,
      value: "user@example.com",
    });
    assert.equal(filled.ok, true);
    assert.equal(filled.fieldName, "email");

    const clicked = await tool.execute("click-ref-3", {
      action: "click",
      tabId: opened.tab.id,
      ref: submitRef.ref,
      snapshotAfter: true,
    });
    assert.equal(clicked.ok, true);
    assert.equal(clicked.method, "post");
    assert.equal(clicked.snapshot.title, "Submitted");
  } finally {
    global.fetch = originalFetch;
  }
});
