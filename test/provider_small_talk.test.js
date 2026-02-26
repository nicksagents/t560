import test from "node:test";
import assert from "node:assert/strict";

import { isSmallTalkMessage } from "../src/provider/run.ts";

test("isSmallTalkMessage accepts natural greeting phrasing", () => {
  assert.equal(isSmallTalkMessage("Hey how are you today"), true);
  assert.equal(isSmallTalkMessage("hello"), true);
});

test("isSmallTalkMessage rejects operational requests", () => {
  assert.equal(isSmallTalkMessage("hey can you run ls"), false);
  assert.equal(isSmallTalkMessage("open github.com"), false);
});
