import test from "node:test";
import assert from "node:assert/strict";

import { createBrowserTool } from "../src/agents/tools/browser-tool.ts";

test("browser launch action uses external launcher and returns visible-to-user metadata", async () => {
  const calls = [];
  const tool = createBrowserTool({
    externalLauncher: async (url, timeoutMs) => {
      calls.push({ url, timeoutMs });
      return {
        command: ["xdg-open", url],
      };
    },
  });

  const out = await tool.execute("t560-launch-1", {
    action: "launch",
    url: "https://www.google.com",
    timeoutMs: 4000,
  });

  assert.equal(out.ok, true);
  assert.equal(out.action, "launch");
  assert.equal(out.launched, true);
  assert.equal(out.visibleToUser, true);
  assert.equal(out.url, "https://www.google.com/");
  assert.ok(Array.isArray(out.command));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://www.google.com/");
  assert.equal(calls[0].timeoutMs, 4000);
});
