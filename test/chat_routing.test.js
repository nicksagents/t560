import test from "node:test";
import assert from "node:assert/strict";

import { chooseRouteSlot } from "../src/agent/chat-service.ts";

test("chooseRouteSlot keeps casual chat on default route", () => {
  assert.equal(chooseRouteSlot("hey how are you today"), "default");
  assert.equal(chooseRouteSlot("thanks"), "default");
  assert.equal(chooseRouteSlot("what is python list comprehension"), "default");
});

test("chooseRouteSlot selects coding only for clear coding intent", () => {
  assert.equal(chooseRouteSlot("please implement auth middleware in src/server.ts"), "coding");
  assert.equal(chooseRouteSlot("unit test is failing with stack trace"), "coding");
});

test("chooseRouteSlot selects planning for architecture and roadmap requests", () => {
  assert.equal(chooseRouteSlot("create a rollout plan for this feature"), "planning");
  assert.equal(chooseRouteSlot("need architecture and technical design doc"), "planning");
  assert.equal(chooseRouteSlot("come up with a list of tasks to complete this migration"), "planning");
});

test("chooseRouteSlot avoids coding route for weak keywords alone", () => {
  assert.equal(chooseRouteSlot("there is a bug with my account login"), "default");
  assert.equal(chooseRouteSlot("python is installed, what now"), "default");
});

test("chooseRouteSlot sends code-producing requests to coding route", () => {
  assert.equal(chooseRouteSlot("write python code for fibonacci with tests"), "coding");
  assert.equal(chooseRouteSlot("implement this in src/auth.ts"), "coding");
});
