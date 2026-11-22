// Voice call limits counted across every server instance: two instances share VOICE_MAX_PER_SHOP and
// VOICE_MAX_TOTAL, calls of a stopped instance stop counting once their heartbeat is stale, a slot is
// given back on hang-up, and without the database each instance keeps its own limits.
import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceGovernor, createSharedVoiceGovernor } from "../src/voice/voiceGovernor.js";

function fakeSessions() {
  const rows = new Map();
  const live = (f) => [...rows.values()].filter((r) => (!f.shop || r.shop === f.shop) && (!f.heartbeatAt || r.heartbeatAt > f.heartbeatAt.$gt));
  return {
    rows,
    async countDocuments(f) { return live(f).length; },
    async create(doc) { rows.set(doc._id, { ...doc }); },
    async deleteOne({ _id }) { rows.delete(_id); },
    async updateMany({ instance }, { $set }) { for (const r of rows.values()) if (r.instance === instance) Object.assign(r, $set); },
  };
}

const limits = { maxPerShop: 2, maxTotal: 3, maxDurationMs: 60_000, idleMs: 60_000, maxChunksPerSecond: 40 };

test("two instances share the per-store and total limits", async () => {
  const Model = fakeSessions();
  let t = 1_000_000;
  const make = (instance) => createSharedVoiceGovernor(createVoiceGovernor(limits), { Model, connected: () => true, now: () => t, instance });
  const a = make("A");
  const b = make("B");
  const s1 = await a.acquire("x.myshopify.com");
  const s2 = await b.acquire("x.myshopify.com");
  assert.ok(s1.ok && s2.ok);
  assert.deepEqual(await a.acquire("x.myshopify.com"), { ok: false, reason: "shop_busy" }, "the store's 2 are taken, one on each instance");
  assert.ok((await b.acquire("y.myshopify.com")).ok);
  assert.deepEqual(await a.acquire("z.myshopify.com"), { ok: false, reason: "server_busy" }, "3 in total across both");
  assert.equal(a.active, 1, "a refused call gives its local slot back");
  s1.release();
  s1.release();
  assert.equal(Model.rows.size, 2);
  assert.ok((await a.acquire("x.myshopify.com")).ok, "a hung-up call frees the slot for everyone");
});

test("calls of an instance that stopped stop counting once their heartbeat is stale", async () => {
  const Model = fakeSessions();
  let t = 5_000_000;
  const dead = createSharedVoiceGovernor(createVoiceGovernor(limits), { Model, connected: () => true, now: () => t, instance: "dead", staleMs: 60_000 });
  const alive = createSharedVoiceGovernor(createVoiceGovernor(limits), { Model, connected: () => true, now: () => t, instance: "alive", staleMs: 60_000 });
  await dead.acquire("x.myshopify.com");
  await dead.acquire("x.myshopify.com");
  assert.equal((await alive.acquire("x.myshopify.com")).ok, false);
  const mine = await alive.acquire("y.myshopify.com");
  t += 61_000;
  alive.beat(); // the live instance keeps its calls fresh; the stopped one cannot
  await new Promise((r) => setImmediate(r));
  assert.ok((await alive.acquire("x.myshopify.com")).ok, "the stopped instance's calls no longer count");
  assert.ok(mine.ok);
});

test("without the database, or when the count cannot be read, the local limits still hold", async () => {
  const offline = createSharedVoiceGovernor(createVoiceGovernor(limits), { Model: fakeSessions(), connected: () => false });
  assert.ok((await offline.acquire("x.myshopify.com")).ok);
  assert.ok((await offline.acquire("x.myshopify.com")).ok);
  assert.equal((await offline.acquire("x.myshopify.com")).ok, false, "local per-store limit");
  const warnings = [];
  const broken = createSharedVoiceGovernor(createVoiceGovernor(limits), { Model: { countDocuments: async () => { throw new Error("down"); } }, connected: () => true, log: { warn: (m) => warnings.push(m) } });
  assert.ok((await broken.acquire("x.myshopify.com")).ok);
  assert.match(warnings[0], /shared session count unavailable/);
});

test("a slot taken in the handshake is given back if the connection never opens", async () => {
  const { voiceUpgradeOptions } = await import("../src/voice/voiceAuth.js");
  const { createVoiceToken } = await import("../src/services/voiceTokenService.js");
  const { createTokenReplayGuard } = await import("../src/services/tokenReplay.js");
  process.env.SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || "governor-test-secret";
  let released = 0;
  const options = voiceUpgradeOptions({ guard: createTokenReplayGuard({ connected: () => false }), allowUrlToken: false, admit: async () => ({ ok: true, release: () => released++ }), claimWithinMs: 30, log: { log() {}, error() {} } });
  const req = { url: "/", headers: { "sec-websocket-protocol": `orbi.voice.v1, orbi.token.${createVoiceToken("x.myshopify.com", { purpose: "voice" })}` } };
  const accepted = await new Promise((resolve) => options.verifyClient({ req }, (ok) => resolve(ok)));
  assert.equal(accepted, true);
  assert.ok(req.voiceSlot.ok);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(released, 1, "never claimed by a connection");
  const req2 = { url: "/", headers: { "sec-websocket-protocol": `orbi.voice.v1, orbi.token.${createVoiceToken("x.myshopify.com", { purpose: "voice" })}` } };
  await new Promise((resolve) => options.verifyClient({ req: req2 }, resolve));
  req2.voiceSlotClaimed = true;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(released, 1, "a claimed slot is the connection's to release");
});
