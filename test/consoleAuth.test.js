// The call window's sign-in: a one-time ticket from a verified dashboard session becomes a session that can only take calls.
import test from "node:test";
import assert from "node:assert/strict";
import { createConsoleTicket, exchangeConsoleTicket, verifyConsoleToken, consoleMayReach } from "../src/admin/consoleAuth.js";
import { requireAdmin } from "../src/admin/auth.js";

process.env.SHOPIFY_CLIENT_SECRET = "console-secret";
const guard = () => { const seen = new Set(); return { consume: async (jti) => (seen.has(jti) ? false : (seen.add(jti), true)) }; };
const active = async () => true;

test("a ticket is swapped for a session once, bound to the store and person that asked", async () => {
  const g = guard();
  const ticket = createConsoleTicket("alpha.myshopify.com", "42");
  const out = await exchangeConsoleTicket(ticket, { guard: g, active });
  assert.equal(out.shop, "alpha.myshopify.com");
  assert.equal(out.userId, "42");
  assert.deepEqual(verifyConsoleToken(out.token), { shop: "alpha.myshopify.com", userId: "42", jti: verifyConsoleToken(out.token).jti, exp: verifyConsoleToken(out.token).exp });
  await assert.rejects(exchangeConsoleTicket(ticket, { guard: g, active }), /invalid_ticket/, "a ticket works once");
});

test("expired, forged, session-as-ticket and uninstalled-store tickets are refused", async () => {
  const g = guard();
  const old = createConsoleTicket("alpha.myshopify.com", "42", Date.now() - 10 * 60_000);
  await assert.rejects(exchangeConsoleTicket(old, { guard: g, active }), /invalid_ticket/);
  await assert.rejects(exchangeConsoleTicket("a.b", { guard: g, active }), /invalid_ticket/);
  const good = createConsoleTicket("alpha.myshopify.com", "42");
  await assert.rejects(exchangeConsoleTicket(good, { guard: g, active: async () => false }), /invalid_ticket/);
  const session = (await exchangeConsoleTicket(createConsoleTicket("alpha.myshopify.com", "42"), { guard: g, active })).token;
  await assert.rejects(exchangeConsoleTicket(session, { guard: g, active }), /invalid_ticket/, "a session is not a ticket");
  assert.equal(verifyConsoleToken(createConsoleTicket("alpha.myshopify.com", "42")), null, "a ticket is not a session");
  const parts = session.split(".");
  assert.equal(verifyConsoleToken(`${parts[0]}.${parts[1].slice(0, -2)}AA`), null, "a tampered signature");
  const forged = Buffer.from(JSON.stringify({ shop: "beta.myshopify.com", user: "42", k: "session", exp: Math.floor(Date.now() / 1000) + 600, jti: "x" })).toString("base64url");
  assert.equal(verifyConsoleToken(`${forged}.${parts[1]}`), null, "another store's claims with this signature");
});

test("a console token reaches only what taking calls needs", () => {
  const ok = [["GET", "/support/state"], ["GET", "/support/calls"], ["POST", "/support/presence"], ["POST", "/support/calls/a1b2c3d4e5f60718293a4b5c/recording"], ["GET", "/conversations/a1b2c3d4e5f60718293a4b5c"], ["POST", "/conversations/a1b2c3d4e5f60718293a4b5c/reply"]];
  for (const [m, p] of ok) assert.equal(consoleMayReach(m, p), true, `${m} ${p}`);
  const no = [["GET", "/orders"], ["GET", "/customers"], ["PUT", "/settings"], ["GET", "/settings"], ["DELETE", "/customers/x"], ["POST", "/support/console-ticket"], ["GET", "/attachments/a1b2c3d4e5f60718293a4b5c"], ["PATCH", "/conversations/a1b2c3d4e5f60718293a4b5c"], ["GET", "/support/calls/a1b2c3d4e5f60718293a4b5c/recording"]];
  for (const [m, p] of no) assert.equal(consoleMayReach(m, p), false, `${m} ${p}`);
});

test("the admin middleware accepts a console token and marks the request as call-window only", async () => {
  const { token } = await exchangeConsoleTicket(createConsoleTicket("alpha.myshopify.com", "42"), { guard: guard(), active });
  const run = (header) => new Promise((resolve) => {
    const req = { get: (h) => (h === "Authorization" ? header : ""), headers: {} };
    const res = { status(code) { this.code = code; return this; }, json(body) { resolve({ code: this.code, body }); } };
    requireAdmin({ verify: () => { throw new Error("invalid_token"); }, active })(req, res, () => resolve({ req }));
  });
  const ok = await run(`Bearer ${token}`);
  assert.equal(ok.req.shop, "alpha.myshopify.com");
  assert.equal(ok.req.adminUser, "42");
  assert.equal(ok.req.consoleOnly, true);
  assert.equal((await run("Bearer nonsense")).code, 401);
  assert.equal((await run("")).code, 401);
  const shopify = await new Promise((resolve) => {
    const req = { get: () => "Bearer anything", headers: {} };
    requireAdmin({ verify: () => ({ shop: "alpha.myshopify.com", userId: "7" }), active })(req, {}, () => resolve(req));
  });
  assert.equal(shopify.consoleOnly, false, "a Shopify session is not call-window only");
});
