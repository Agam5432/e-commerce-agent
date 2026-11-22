// The Gmail login is checked at startup, so a wrong App Password shows in the log right away.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { verifyEmailTransport, sendOrderConfirmationEmail } from "../src/services/emailService.js";

const saved = { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD };
afterEach(() => {
  process.env.EMAIL_USER = saved.user ?? "";
  process.env.EMAIL_APP_PASSWORD = saved.pass ?? "";
});
function recorder() {
  const lines = [];
  const add = (level) => (msg) => lines.push(`${level}: ${msg}`);
  return { lines, log: { info: add("info"), warn: add("warn"), error: add("error") } };
}

test("missing Gmail settings are reported, not silent", async () => {
  process.env.EMAIL_USER = "";
  process.env.EMAIL_APP_PASSWORD = "";
  const r = recorder();
  const out = await verifyEmailTransport({ transport: null, log: r.log });
  assert.equal(out.ok, false);
  assert.match(r.lines[0], /^warn: .*not set/);
});

test("a working Gmail login is confirmed in the log", async () => {
  process.env.EMAIL_USER = "shop@gmail.com";
  process.env.EMAIL_APP_PASSWORD = "abcdabcdabcdabcd";
  const r = recorder();
  const out = await verifyEmailTransport({ transport: { verify: async () => true }, log: r.log });
  assert.deepEqual(out, { ok: true, user: "shop@gmail.com" });
  assert.match(r.lines[0], /Gmail SMTP ready as shop@gmail\.com/);
});

test("a rejected App Password says exactly what to do", async () => {
  process.env.EMAIL_USER = "shop@gmail.com";
  process.env.EMAIL_APP_PASSWORD = "wrong";
  const r = recorder();
  const err = Object.assign(new Error("Invalid login: 535-5.7.8 Username and Password not accepted"), { code: "EAUTH" });
  const out = await verifyEmailTransport({ transport: { verify: async () => { throw err; } }, log: r.log });
  assert.equal(out.ok, false);
  assert.match(r.lines[0], /^error: .*535.*new App Password/);
});

test("an order without a usable recipient explains why no email went out", async () => {
  process.env.EMAIL_USER = "shop@gmail.com";
  process.env.EMAIL_APP_PASSWORD = "abcdabcdabcdabcd";
  const out = await sendOrderConfirmationEmail({ to: "", orderId: "#1001" });
  assert.deepEqual(out, { ok: false, error: "no valid recipient email for this order" });
});

test("a dropped connection is retried and then reported as ready", async () => {
  process.env.EMAIL_USER = "a@b.c"; process.env.EMAIL_APP_PASSWORD = "x";
  let calls = 0;
  const logs = { warn: [], info: [], error: [] };
  const log = { warn: (m) => logs.warn.push(m), info: (m) => logs.info.push(m), error: (m) => logs.error.push(m) };
  const transport = { verify: async () => { if (++calls < 3) throw new Error("socket disconnected"); } };
  const r = await verifyEmailTransport({ transport, log, sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.equal(calls, 3);
  assert.equal(logs.error.length, 0);
});

test("a wrong password is not retried", async () => {
  process.env.EMAIL_USER = "a@b.c"; process.env.EMAIL_APP_PASSWORD = "x";
  let calls = 0;
  const transport = { verify: async () => { calls++; throw new Error("535 Invalid login"); } };
  const r = await verifyEmailTransport({ transport, log: { warn() {}, info() {}, error() {} }, sleep: async () => {} });
  assert.equal(r.ok, false);
  assert.equal(calls, 1);
});
