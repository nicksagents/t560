import test from "node:test";
import assert from "node:assert/strict";

import {
  extractOutputText,
  isUnstoredInputItemReferenceError,
  sanitizeInputForUnstoredReplay,
} from "../src/openai/responses.js";

test("detects unstored item reference errors", () => {
  const err = new Error(
    "Item with id 'rs_123' not found. Items are not persisted when `store` is set to false.",
  );
  assert.equal(isUnstoredInputItemReferenceError(err), true);
});

test("ignores unrelated errors", () => {
  const err = new Error("OpenAI API error (status 401)");
  assert.equal(isUnstoredInputItemReferenceError(err), false);
});

test("sanitizes replay payload by stripping reference IDs", () => {
  const input = [
    { role: "user", content: "hi" },
    { id: "rs_bare_reference" },
    { type: "reasoning", id: "rs_keep", summary: [{ type: "summary_text", text: "thought" }] },
    { type: "function_call", id: "fc_123", call_id: "call_1", name: "noop", arguments: "{}" },
    { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
  ];

  const out = sanitizeInputForUnstoredReplay(input);

  assert.equal(out.length, 4);
  assert.equal(out.some((item) => item?.id === "rs_bare_reference"), false);
  assert.equal(out.some((item) => item?.type === "reasoning" && "id" in item), false);
  assert.equal(out.some((item) => item?.type === "function_call" && "id" in item), false);
  assert.equal(out.some((item) => item?.type === "message" && "id" in item), false);
});

test("drops empty reasoning references", () => {
  const input = [{ type: "reasoning", id: "rs_empty" }];
  const out = sanitizeInputForUnstoredReplay(input);
  assert.deepEqual(out, []);
});

test("extracts direct output_text fallback", () => {
  const json = { output_text: "Hello from direct field" };
  assert.equal(extractOutputText(json), "Hello from direct field");
});

test("extracts assistant text blocks with non-output_text types", () => {
  const json = {
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Alpha" }, { type: "refusal", refusal: "Beta" }],
      },
    ],
  };
  assert.equal(extractOutputText(json), "Alpha\nBeta");
});
