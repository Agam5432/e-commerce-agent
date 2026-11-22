// Every model is registered once, however many times its file is loaded (a second copy of a module,
// a test that re-imports): `mongoose.models.X || mongoose.model(...)`.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

test("every model file reuses an already-registered model", () => {
  const dir = new URL("../src/models/", import.meta.url);
  const missing = readdirSync(dir).filter((f) => f.endsWith(".js")).filter((f) => {
    const s = readFileSync(new URL(f, dir), "utf8");
    return /mongoose\.model\(/.test(s) && !/mongoose\.models\.\w+\s*\|\|\s*mongoose\.model\(/.test(s);
  });
  assert.deepEqual(missing, []);
});

test("loading a model file twice does not throw", async () => {
  await import("../src/models/StoreIntegration.js");
  await import(`../src/models/StoreIntegration.js?again=${Date.now()}`);
  await import(`../src/models/CheckoutSession.js?again=${Date.now()}`);
  await import(`../src/models/OrderSubmission.js?again=${Date.now()}`);
});
