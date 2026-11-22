import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceGovernor, voiceLimitsFromEnv } from "../src/voice/voiceGovernor.js";

const limits = { maxPerShop: 2, maxTotal: 3, maxDurationMs: 60_000, idleMs: 10_000, maxChunksPerSecond: 5 };

test("a store cannot hold more voice sessions than its limit, and a freed slot is reusable", () => {
  const g = createVoiceGovernor(limits);
  const a = g.acquire("a.myshopify.com");
  const b = g.acquire("a.myshopify.com");
  assert.equal(g.acquire("a.myshopify.com").reason, "shop_busy");
  a.release();
  a.release(); // double release must not free a second slot
  assert.equal(g.activeFor("a.myshopify.com"), 1);
  assert.ok(g.acquire("a.myshopify.com").ok);
  b.release();
});

test("the server-wide cap protects every store", () => {
  const g = createVoiceGovernor(limits);
  g.acquire("a.myshopify.com"); g.acquire("b.myshopify.com"); g.acquire("c.myshopify.com");
  assert.equal(g.acquire("d.myshopify.com").reason, "server_busy");
  assert.equal(g.active, 3);
});

test("sessions end on silence or at the time limit", () => {
  let t = 0;
  const g = createVoiceGovernor(limits, { now: () => t });
  const w = g.watch();
  assert.equal(w.expired(), null);
  t = 5_000; w.audio();
  t = 14_000;
  assert.equal(w.expired(), null);
  t = 15_001;
  assert.equal(w.expired(), "idle");
  const long = createVoiceGovernor({ ...limits, idleMs: 1e9 }, { now: () => t }).watch();
  t += 61_000;
  assert.equal(long.expired(), "max_duration");
});

test("audio faster than real time is refused, normal speed passes", () => {
  let t = 0;
  const w = createVoiceGovernor(limits, { now: () => t }).watch();
  const results = Array.from({ length: 7 }, () => w.audio());
  assert.deepEqual(results, [true, true, true, true, true, false, false]);
  t = 1_100;
  assert.equal(w.audio(), true);
});

test("limits come from env with safe defaults for bad values", () => {
  assert.equal(voiceLimitsFromEnv({}).maxPerShop, 25);
  assert.equal(voiceLimitsFromEnv({ VOICE_MAX_PER_SHOP: "abc" }).maxPerShop, 25);
  assert.equal(voiceLimitsFromEnv({ VOICE_MAX_MINUTES: "5" }).maxDurationMs, 300_000);
});
