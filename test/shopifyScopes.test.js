// Every Shopify permission the app asks for has a reason and code that really uses it; the defaults,
// the example settings and (when the app folder is next to this one) the app's toml all agree.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SHOPIFY_SCOPES, DEFAULT_SCOPES } from "../src/config/shopifyScopes.js";
import { getEffectiveScopes } from "../src/routes/shopifyOAuthRoutes.js";

const root = new URL("..", import.meta.url);

test("each requested scope is used by the code named for it", () => {
  for (const { scope, why, file, uses } of SHOPIFY_SCOPES) {
    assert.ok(why.length > 20, `${scope} needs a reason`);
    const source = readFileSync(new URL(file, root), "utf8");
    assert.match(source, uses, `${scope}: ${file} no longer uses it; stop asking for it`);
  }
  assert.equal(new Set(SHOPIFY_SCOPES.map((s) => s.scope)).size, SHOPIFY_SCOPES.length, "no duplicates");
});

test("the defaults, the example settings and the toml ask for the same scopes", () => {
  const saved = process.env.SHOPIFY_SCOPES;
  delete process.env.SHOPIFY_SCOPES;
  try {
    assert.deepEqual(getEffectiveScopes().split(",").sort(), DEFAULT_SCOPES.split(",").sort());
  } finally {
    if (saved !== undefined) process.env.SHOPIFY_SCOPES = saved;
  }
  const example = readFileSync(new URL(".env.example", root), "utf8").match(/^SHOPIFY_SCOPES=(.*)$/m)[1];
  assert.deepEqual(example.split(",").sort(), DEFAULT_SCOPES.split(",").sort());
  // the app config now lives in this repository, so a missing file is a failure, not a silent skip
  const toml = new URL("shopify-app/shopify.app.ai-commerce-agent.toml", root);
  const scopes = readFileSync(toml, "utf8").match(/^scopes\s*=\s*"([^"]*)"/m)[1];
  assert.deepEqual(scopes.split(",").sort(), DEFAULT_SCOPES.split(",").sort());
});
