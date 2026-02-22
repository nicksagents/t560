import test from "node:test";
import assert from "node:assert/strict";

import { parseDuckDuckGoHtml } from "../src/web/duckduckgo_search.js";
import { webFetch } from "../src/web/fetch.js";

test("parseDuckDuckGoHtml extracts redirected URLs, titles, and snippets", () => {
  const html = `
    <html>
      <body>
        <div class="result">
          <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha">
            Example Alpha
          </a>
          <a class="result__snippet">Alpha description text.</a>
        </div>
        <div class="result">
          <a class="result__a" href="https://example.org/beta">Example Beta</a>
          <div class="result__snippet">Beta description text.</div>
        </div>
      </body>
    </html>
  `;

  const rows = parseDuckDuckGoHtml(html, 5);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, "Example Alpha");
  assert.equal(rows[0].url, "https://example.com/alpha");
  assert.match(rows[0].description, /Alpha description text/i);
  assert.equal(rows[1].url, "https://example.org/beta");
});

test("webFetch converts HTML to readable text", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      `
        <html>
          <head>
            <title>Ignored</title>
            <style>.x { color: red; }</style>
          </head>
          <body>
            <h1>Hello</h1>
            <p>World</p>
            <script>console.log("ignore")</script>
          </body>
        </html>
      `,
      {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    );

  try {
    const out = await webFetch({ url: "https://example.com" });
    assert.equal(out.ok, true);
    assert.equal(out.status, 200);
    assert.match(out.text, /Hello/);
    assert.match(out.text, /World/);
    assert.equal(/console\.log/.test(out.text), false);
    assert.equal(/<h1>/.test(out.text), false);
  } finally {
    global.fetch = originalFetch;
  }
});
