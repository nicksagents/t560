import test from "node:test";
import assert from "node:assert/strict";

import { createBrowserTool } from "../src/agents/tools/browser-tool.ts";

test("browser falls back to fetch when engine=live is requested but live runtime is unavailable", async () => {
  const tool = createBrowserTool({ allowLiveEngine: false });
  const previousFetch = global.fetch;

  global.fetch = async (input) => {
    const url = String(input ?? "");
    if (url.includes("example.com/fallback")) {
      return new Response(
        `
          <html>
            <head><title>Fallback Works</title></head>
            <body>ok</body>
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
    await tool.execute("t560-foundation-reset-1", { action: "reset" });
    const opened = await tool.execute("t560-foundation-open-1", {
      action: "open",
      url: "https://example.com/fallback",
      engine: "live",
      snapshotAfter: true,
    });
    assert.equal(opened.ok, true);
    assert.equal(opened.engine, "fetch");
    assert.equal(opened.fallbackFrom, "live");
    assert.match(String(opened.snapshot?.title), /Fallback Works/);
  } finally {
    global.fetch = previousFetch;
  }
});

test("browser respects allowEngineFallback=false when engine=live is unavailable", async () => {
  const tool = createBrowserTool({ allowLiveEngine: false });
  await tool.execute("t560-foundation-reset-2", { action: "reset" });
  await assert.rejects(
    () =>
      tool.execute("t560-foundation-open-2", {
        action: "open",
        url: "https://example.com/blocked",
        engine: "live",
        allowEngineFallback: false,
      }),
    /engine=live requested but unavailable/i,
  );
});

test("browser products action extracts deterministic ecommerce candidates from current tab", async () => {
  const tool = createBrowserTool();
  const previousFetch = global.fetch;

  global.fetch = async (input) => {
    const url = String(input ?? "");
    if (url.includes("example.com/products")) {
      return new Response(
        `
          <html>
            <head><title>Raspberry Pi Listings</title></head>
            <body>
              <a href="https://www.amazon.ca/dp/B0P1">Raspberry Pi 5 16GB C$169.99</a>
              <a href="https://www.amazon.ca/dp/B0P2">Raspberry Pi 5 16GB C$149.99</a>
              <a href="https://www.amazon.ca/dp/B0P3">Raspberry Pi 5 16GB C$189.99</a>
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
    await tool.execute("t560-foundation-reset-3", { action: "reset" });
    const opened = await tool.execute("t560-foundation-open-3", {
      action: "open",
      url: "https://example.com/products",
      snapshotAfter: true,
    });
    assert.equal(opened.ok, true);

    const products = await tool.execute("t560-foundation-products-1", {
      action: "products",
      tabId: opened.tab.id,
      query: "cheapest raspberry pi 16gb",
      limit: 8,
    });
    assert.equal(products.ok, true);
    assert.ok(Array.isArray(products.products));
    assert.ok(products.products.length >= 3);
    assert.equal(products.cheapest.url, "https://www.amazon.ca/dp/B0P2");
    assert.equal(products.cheapest.price.amount, 149.99);
  } finally {
    global.fetch = previousFetch;
  }
});
