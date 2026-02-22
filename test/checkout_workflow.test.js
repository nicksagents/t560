import test from "node:test";
import assert from "node:assert/strict";

import {
  beginCheckoutWorkflowTurn,
  describeCheckoutWorkflowState,
  enforceCheckoutWorkflow,
} from "../src/agents/checkout-workflow.ts";

test("checkout workflow blocks risky browser actions until user confirms purchase", () => {
  const sessionId = `checkout-test-${Date.now()}`;

  beginCheckoutWorkflowTurn({
    sessionId,
    userMessage: "please add this to cart and place order",
  });

  const blocked = enforceCheckoutWorkflow({
    sessionId,
    toolName: "browser",
    toolArgs: {
      action: "click",
      selector: "button:has-text('Place order')",
    },
  });
  assert.equal(blocked.allowed, false);
  if (blocked.allowed) {
    assert.fail("expected checkout action to be blocked");
  }
  assert.match(blocked.message, /confirm purchase/i);
  assert.match(String(describeCheckoutWorkflowState(sessionId)), /pending/i);

  const turn = beginCheckoutWorkflowTurn({
    sessionId,
    userMessage: "confirm purchase",
  });
  assert.equal(turn.confirmedThisTurn, true);

  const allowed = enforceCheckoutWorkflow({
    sessionId,
    toolName: "browser",
    toolArgs: {
      action: "click",
      selector: "button:has-text('Place order')",
    },
  });
  assert.equal(allowed.allowed, true);
  assert.match(String(describeCheckoutWorkflowState(sessionId)), /active/i);
});
