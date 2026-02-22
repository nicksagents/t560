import test from "node:test";
import assert from "node:assert/strict";

import { createWebFetchTool, createWebSearchTool } from "../src/agents/tools/web-tools.ts";

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

test("web_search falls back to DuckDuckGo by default without Brave API key", async () => {
  const prev = process.env.BRAVE_API_KEY;
  const prevFetch = global.fetch;
  delete process.env.BRAVE_API_KEY;
  global.fetch = async (input) => {
    const url = String(input ?? "");
    if (url.includes("duckduckgo.com/html/") || url.includes("lite.duckduckgo.com/lite/")) {
      return new Response(
        `
          <html>
            <body>
              <a class="result__a" href="https://example.com/fallback">Fallback Doc</a>
              <a class="result__snippet">Fallback snippet</a>
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
    const out = await tool.execute("web-fallback-1", {
      query: "latest t560 news",
    });
    assert.equal(out.provider, "duckduckgo");
    assert.equal(out.fallbackFrom, "brave");
    assert.equal(out.count, 1);
  } finally {
    global.fetch = prevFetch;
    restoreEnv("BRAVE_API_KEY", prev);
  }
});

test("web_search remains unavailable when provider is explicitly brave without key", () => {
  const prev = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;
  try {
    const tool = createWebSearchTool({
      config: {
        tools: {
          web: {
            search: {
              provider: "brave",
            },
          },
        },
      },
    });
    assert.equal(tool, null);
  } finally {
    restoreEnv("BRAVE_API_KEY", prev);
  }
});

test("web_search uses Brave with configured key", async () => {
  const prevKey = process.env.BRAVE_API_KEY;
  const prevFetch = global.fetch;
  process.env.BRAVE_API_KEY = "brave-test-key";

  const seen = [];
  global.fetch = async (input, init = {}) => {
    const url = String(input ?? "");
    seen.push({ url, headers: init?.headers ?? {} });
    const parsed = new URL(url);
    assert.equal(parsed.hostname, "api.search.brave.com");
    const q = String(parsed.searchParams.get("q") ?? "");
    assert.match(q, /latest t560 release/i);
    assert.match(q, /\b20\d{2}\b/);
    assert.equal(parsed.searchParams.get("count"), "10");
    return new Response(
      JSON.stringify({
        web: {
          results: [
            {
              title: "T560 Release Notes",
              url: "https://example.com/releases",
              description: "Release summary",
            },
          ],
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const tool = createWebSearchTool({
      config: {
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "brave",
            },
          },
        },
      },
    });
    assert.ok(tool);

    const out = await tool.execute("web-brave-1", {
      query: "latest t560 release",
      count: 99,
    });

    assert.equal(out.provider, "brave");
    assert.equal(out.count, 1);
    assert.equal(out.results[0].title, "T560 Release Notes");
    assert.equal(String(seen[0].headers["X-Subscription-Token"]), "brave-test-key");
  } finally {
    global.fetch = prevFetch;
    restoreEnv("BRAVE_API_KEY", prevKey);
  }
});

test("web_search anchors temporal olympics query to current year and ranks current-year result first", async () => {
  const prev = process.env.BRAVE_API_KEY;
  const prevFetch = global.fetch;
  delete process.env.BRAVE_API_KEY;
  const year = new Date().getUTCFullYear();

  global.fetch = async (input) => {
    const url = String(input ?? "");
    if (url.includes("duckduckgo.com/html/") || url.includes("lite.duckduckgo.com/lite/")) {
      const parsed = new URL(url);
      const q = String(parsed.searchParams.get("q") ?? "");
      assert.match(q, new RegExp(`\\b${year}\\b`));
      return new Response(
        `
          <html>
            <body>
              <a class="result__a" href="https://example.com/olympics/paris-2024-medal-table">Olympics Medal Table 2024</a>
              <a class="result__snippet">Paris 2024 standings</a>
              <a class="result__a" href="https://example.com/olympics/milan-cortina-${year}-medal-table">Olympics Medal Table ${year}</a>
              <a class="result__snippet">Current standings ${year}</a>
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
    const out = await tool.execute("web-olympics-year-anchor", {
      query: "current olympics medal table by country",
    });
    assert.equal(out.provider, "duckduckgo");
    assert.equal(out.temporalIntent, true);
    assert.equal(out.anchorYear, year);
    assert.equal(out.queryAnchoredToCurrentYear, true);
    assert.ok(out.results.length > 0);
    assert.match(String(out.results[0].url), new RegExp(`${year}`));
  } finally {
    global.fetch = prevFetch;
    restoreEnv("BRAVE_API_KEY", prev);
  }
});

test("web_search supports duckduckgo provider without API key", async () => {
  const prevKey = process.env.BRAVE_API_KEY;
  const prevFetch = global.fetch;
  delete process.env.BRAVE_API_KEY;

  global.fetch = async (input) => {
    const url = String(input ?? "");
    if (url.includes("duckduckgo.com/html/") || url.includes("lite.duckduckgo.com/lite/")) {
      return new Response(
        `
          <html>
            <body>
              <div class="result">
                <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc">Doc</a>
                <a class="result__snippet">Doc snippet text</a>
              </div>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      );
    }
    if (url === "https://example.com/doc") {
      return new Response(
        `
          <html>
            <body>
              <h1>Duck Source</h1>
              <p>Grounded text</p>
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
    const tool = createWebSearchTool({
      config: {
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "duckduckgo",
            },
          },
        },
      },
    });
    assert.ok(tool);

    const out = await tool.execute("web-ddg-1", {
      query: "t560 docs",
      fetchTop: 1,
    });

    assert.equal(out.provider, "duckduckgo");
    assert.equal(out.count, 1);
    assert.equal(out.results[0].url, "https://example.com/doc");
    assert.equal(out.pages.length, 1);
    assert.match(String(out.pages[0].textPreview), /Duck Source/);
  } finally {
    global.fetch = prevFetch;
    restoreEnv("BRAVE_API_KEY", prevKey);
  }
});

test("web_search allows provider override to duckduckgo when brave is configured", async () => {
  const prevKey = process.env.BRAVE_API_KEY;
  const prevFetch = global.fetch;
  process.env.BRAVE_API_KEY = "brave-test-key";

  global.fetch = async (input) => {
    const url = String(input ?? "");
    assert.match(url, /duckduckgo\.com\/html\/|lite\.duckduckgo\.com\/lite\//);
    return new Response(
      `
        <html>
          <body>
            <a class="result__a" href="https://example.com/override">Override result</a>
            <a class="result__snippet">Duck override snippet</a>
          </body>
        </html>
      `,
      {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    );
  };

  try {
    const tool = createWebSearchTool({
      config: {
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "brave",
            },
          },
        },
      },
    });
    assert.ok(tool);
    const out = await tool.execute("web-override-ddg", {
      query: "override provider",
      provider: "duckduckgo",
    });
    assert.equal(out.provider, "duckduckgo");
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].url, "https://example.com/override");
  } finally {
    global.fetch = prevFetch;
    restoreEnv("BRAVE_API_KEY", prevKey);
  }
});

test("web_search falls back to duckduckgo when brave runtime call fails", async () => {
  const prevKey = process.env.BRAVE_API_KEY;
  const prevFetch = global.fetch;
  process.env.BRAVE_API_KEY = "brave-test-key";
  const seen = [];

  global.fetch = async (input) => {
    const url = String(input ?? "");
    seen.push(url);
    if (url.includes("api.search.brave.com")) {
      return new Response(JSON.stringify({ message: "quota exceeded" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("duckduckgo.com/html/") || url.includes("lite.duckduckgo.com/lite/")) {
      return new Response(
        `
          <html>
            <body>
              <a class="result__a" href="https://example.com/failover">Failover result</a>
              <a class="result__snippet">Fallback search snippet</a>
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
    const tool = createWebSearchTool({
      config: {
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "brave",
            },
          },
        },
      },
    });
    assert.ok(tool);
    const out = await tool.execute("web-runtime-fallback", {
      query: "runtime fallback",
    });
    assert.equal(out.provider, "duckduckgo");
    assert.equal(out.fallbackFrom, "brave");
    assert.match(String(out.providerError), /quota exceeded/i);
    assert.ok(seen.some((url) => url.includes("api.search.brave.com")));
    assert.ok(seen.some((url) => url.includes("duckduckgo.com/html/") || url.includes("lite.duckduckgo.com/lite/")));
  } finally {
    global.fetch = prevFetch;
    restoreEnv("BRAVE_API_KEY", prevKey);
  }
});

test("web_search applies domain filter and recency query hint", async () => {
  const prev = process.env.BRAVE_API_KEY;
  const prevFetch = global.fetch;
  delete process.env.BRAVE_API_KEY;
  const seenQueries = [];

  global.fetch = async (input) => {
    const url = String(input ?? "");
    if (url.includes("duckduckgo.com/html/") || url.includes("lite.duckduckgo.com/lite/")) {
      const parsed = new URL(url);
      seenQueries.push(parsed.searchParams.get("q") ?? "");
      return new Response(
        `
          <html>
            <body>
              <a class="result__a" href="https://example.com/a">Result A</a>
              <a class="result__snippet">Snippet A</a>
              <a class="result__a" href="https://www.amazon.ca/target">Result B</a>
              <a class="result__snippet">Snippet B</a>
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
    const out = await tool.execute("web-domain-filter", {
      query: "raspberry pi 16gb",
      recency: 7,
      domains: ["amazon.ca"],
    });
    assert.equal(out.provider, "duckduckgo");
    assert.equal(out.results.length, 1);
    assert.match(String(out.results[0].url), /^https:\/\/(www\.)?amazon\.ca\/target$/);
    assert.equal(out.recencyDays, 7);
    assert.match(String(out.queryUsed), /past week/i);
    assert.ok(Array.isArray(out.domains));
    assert.equal(out.domains[0], "amazon.ca");
    assert.ok(seenQueries.some((q) => /past week/i.test(q)));
  } finally {
    global.fetch = prevFetch;
    restoreEnv("BRAVE_API_KEY", prev);
  }
});

test("web_fetch can be disabled by config", () => {
  const tool = createWebFetchTool({
    config: {
      tools: {
        web: {
          fetch: {
            enabled: false,
          },
        },
      },
    },
  });
  assert.equal(tool, null);
});
