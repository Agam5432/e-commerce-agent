// Emails that fail for a passing reason are kept and sent again; ones that failed for good are not;
// a wrong password raises an alert; after the last try the email is given up.
import test from "node:test";
import assert from "node:assert/strict";
import { createEmailOutbox, isTransientEmailError, emailRetryDelayMs } from "../src/services/emailOutbox.js";

function fakeOutbox() {
  const rows = [];
  let n = 0;
  const due = (r, f, t) => f.$or.some((c) => (c.status === r.status) && (c.nextAttemptAt ? r.nextAttemptAt <= c.nextAttemptAt.$lte : r.lockedUntil < c.lockedUntil.$lt));
  return {
    rows,
    async create(doc) { rows.push({ _id: ++n, ...doc }); },
    async findOneAndUpdate(f, u) {
      const row = rows.filter((r) => due(r, f)).sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)[0];
      if (!row) return null;
      Object.assign(row, u.$set);
      row.attempts += u.$inc.attempts;
      return { ...row };
    },
    async deleteOne({ _id }) { rows.splice(rows.findIndex((r) => r._id === _id), 1); },
    async updateOne({ _id }, u) {
      const row = rows.find((r) => r._id === _id);
      Object.assign(row, u.$set);
      for (const k of Object.keys(u.$unset || {})) delete row[k];
    },
  };
}

test("which failures are worth another try", () => {
  assert.equal(isTransientEmailError(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })), true);
  assert.equal(isTransientEmailError(Object.assign(new Error("421 try later"), { responseCode: 421 })), true);
  assert.equal(isTransientEmailError(Object.assign(new Error("Greeting never received"), {})), true);
  assert.equal(isTransientEmailError(Object.assign(new Error("550 no such user"), { responseCode: 550 })), false);
  assert.equal(isTransientEmailError(Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535 })), false);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(emailRetryDelayMs), [60_000, 300_000, 900_000, 3_600_000, 14_400_000, 28_800_000]);
});

test("a passing failure is kept and sent on a later try, then removed", async () => {
  const Model = fakeOutbox();
  let t = 1_000_000;
  const outbox = createEmailOutbox({ Model, connected: () => true, now: () => t, log: { warn() {} } });
  const message = { from: "s@x.com", to: "asha@example.com", subject: "Order #1001", text: "Thanks", html: "<p>Thanks</p>", attachments: [{ filename: "call.ics", content: "BEGIN:VCALENDAR" }, { filename: "bin", content: Buffer.from("x") }] };
  assert.equal(await outbox.keep({ kind: "order_confirmation", shop: "a.myshopify.com", message, error: Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }) }), true);
  assert.deepEqual(Model.rows[0].message.attachments, [{ filename: "call.ics", content: "BEGIN:VCALENDAR", contentType: undefined }], "only text attachments are stored");
  const sent = [];
  assert.equal(await outbox.sweep({ send: async (m) => sent.push(m) }), 0, "not due yet");
  t += 61_000;
  assert.equal(await outbox.sweep({ send: async (m) => sent.push(m) }), 1);
  assert.equal(sent[0].to, "asha@example.com");
  assert.equal(Model.rows.length, 0, "removed once sent");
});

test("a permanent failure is not kept; a refused login is not kept either", async () => {
  const Model = fakeOutbox();
  const outbox = createEmailOutbox({ Model, connected: () => true });
  assert.equal(await outbox.keep({ kind: "x", message: { to: "a@b.c" }, error: Object.assign(new Error("550 no such user"), { responseCode: 550 }) }), false);
  assert.equal(await outbox.keep({ kind: "x", message: { to: "a@b.c" }, error: Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535 }) }), false);
  assert.equal(Model.rows.length, 0);
  assert.equal(await createEmailOutbox({ Model, connected: () => false }).keep({ kind: "x", message: { to: "a" }, error: { code: "ETIMEDOUT" } }), false, "no database: nothing to keep it in");
});

test("after the last try the email is given up", async () => {
  const Model = fakeOutbox();
  let t = 0;
  const outbox = createEmailOutbox({ Model, connected: () => true, now: () => t, maxAttempts: 3, log: { warn() {} } });
  await outbox.keep({ kind: "owner_chat_alert", message: { to: "o@s.com" }, error: { code: "ETIMEDOUT", message: "timeout" } });
  const failing = async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); };
  for (let i = 0; i < 5; i++) {
    t += 10 * 3_600_000;
    await outbox.sweep({ send: failing });
  }
  assert.equal(Model.rows[0].status, "dead");
  assert.equal(Model.rows[0].attempts, 3);
});

test("the order confirmation and the owner's alerts ask to be kept; the one-time code does not", async () => {
  const { readFileSync } = await import("node:fs");
  const email = readFileSync(new URL("../src/services/emailService.js", import.meta.url), "utf8");
  const booking = readFileSync(new URL("../src/services/bookingEmails.js", import.meta.url), "utf8");
  assert.match(email, /keep\(\{ kind: "order_confirmation"/);
  assert.match(booking, /retry: \{ kind: "owner_call_alert"/);
  assert.match(booking, /retry: \{ kind: "owner_chat_alert"/);
  const otp = email.slice(email.indexOf("export async function sendOtpEmail"), email.indexOf("export async function sendPlainEmail"));
  assert.doesNotMatch(otp, /keep\(|retry:/);
});
