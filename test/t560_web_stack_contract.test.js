import test from "node:test";
import assert from "node:assert/strict";

import { createBrowserTool } from "../src/agents/tools/browser-tool.ts";
import { createWebSearchTool } from "../src/agents/tools/web-tools.ts";

test("browser open/snapshot returns stable t560 contract fields", async () => {
  const tool = createBrowserTool();
  const previousFetch = global.fetch;

  global.fetch = async (input) => {
    const url = String(input ?? "");
    if (url.includes("example.com/contract")) {
      return new Response(
        `
          <html>
            <head><title>Contract Page</title></head>
            <body>
              <a href="https://example.com/next">Next</a>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      );
    }
    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  };

  try {
    await tool.execute("contract-reset", { action: "reset" });
    const opened = await tool.execute("contract-open", {
      action: "open",
      url: "https://example.com/contract",
      snapshotAfter: true,
    });
    assert.equal(opened.ok, true);
    assert.equal(typeof opened.snapshot.url, "string");
    assert.equal(Array.isArray(opened.snapshot.links), true);
    assert.equal(Array.isArray(opened.snapshot.refs), true);
    assert.ok(opened.snapshot.refs.some((entry) => typeof entry.ref === "string"));
  } finally {
    global.fetch = previousFetch;
  }
});

test("web_search returns ranked results and commerce candidates in t560 contract", async () => {
  const previousKey = process.env.BRAVE_API_KEY;
  const previousFetch = global.fetch;
  delete process.env.BRAVE_API_KEY;

  global.fetch = async (input) => {
    const url = String(input ?? "");
    if (url.includes("duckduckgo.com/html/") || url.includes("lite.duckduckgo.com/lite/")) {
      return new Response(
        `
          <html>
            <body>
              <a class="result__a" href="https://www.amazon.ca/dp/B0CONTRACT">Raspberry Pi 5 16GB C$199.99</a>
              <a class="result__snippet">In stock now</a>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      );
    }
    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  };

  try {
    const tool = createWebSearchTool();
    assert.ok(tool);
    const out = await tool.execute("contract-web", {
      query: "raspberry pi 16gb price",
      domains: ["amazon.ca"],
    });
    assert.equal(Array.isArray(out.results), true);
    assert.ok(out.results.length > 0);
    assert.equal(Array.isArray(out.products), true);
    assert.equal(out.products[0].price.amount, 199.99);
    assert.equal(typeof out.products[0].url, "string");
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) {
      delete process.env.BRAVE_API_KEY;
    } else {
      process.env.BRAVE_API_KEY = previousKey;
    }
  }
});
