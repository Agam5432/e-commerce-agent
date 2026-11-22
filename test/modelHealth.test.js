import test from "node:test";
import assert from "node:assert/strict";
import { createModelHealth } from "../src/agent/modelHealth.js";

test("quota and retired models are skipped across turns while a healthy provider remains usable", () => {
  let now = 1000;
  const health = createModelHealth(() => now);
  health.fail("gemini", "retired", { status: 404, message: "no longer available" });
  health.fail("gemini", "limited", { status: 429, headers: { "retry-after": "120" } });
  assert.equal(health.available("gemini", "retired"), false);
  assert.equal(health.available("gemini", "limited"), false);
  assert.equal(health.available("groq", "working"), true);
  now += 119999;
  assert.equal(health.available("gemini", "limited"), false);
  now++;
  assert.equal(health.available("gemini", "limited"), true);
  assert.equal(health.available("gemini", "retired"), false);
});

test("a rate limit pauses a model only for as long as needed, so one burst does not take the store offline", () => {
  let now = 0;
  const health = createModelHealth(() => now);
  assert.equal(health.fail("claude", "haiku", { status: 429 }), 15000);
  assert.equal(health.fail("claude", "haiku", { status: 429, headers: { "retry-after": "1" } }), 5000);
  now += 5000;
  assert.equal(health.available("claude", "haiku"), true);
});

test("temporary service failures back off across failed probes and reset on recovery", () => {
  let now = 0;
  const health = createModelHealth(() => now);
  assert.equal(health.fail("gemini", "busy", new Error('{"error":{"code":503,"message":"high demand"}}')), 30000);
  now += 30000;
  assert.equal(health.available("gemini", "busy"), true);
  assert.equal(health.fail("gemini", "busy", new Error("aborted")), 60000);
  health.success("gemini", "busy");
  assert.equal(health.available("gemini", "busy"), true);
  assert.equal(health.fail("gemini", "busy", new Error("timeout")), 30000);
});
