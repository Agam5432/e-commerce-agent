import test from "node:test";
import assert from "node:assert/strict";
import { sideGeminiModel } from "../src/agent/agent.js";
import { DEFAULT_GEMINI_LIGHT_MODEL } from "../src/agent/core/config.js";

test("short side calls use the fast light model, whatever order the main chain is in", () => {
  assert.equal(sideGeminiModel({}), DEFAULT_GEMINI_LIGHT_MODEL);
});

test("GEMINI_LIGHT_MODEL overrides the side-call model", () => {
  assert.equal(sideGeminiModel({ GEMINI_LIGHT_MODEL: "gemini-custom-lite" }), "gemini-custom-lite");
});
