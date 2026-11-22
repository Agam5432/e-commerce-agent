import test from "node:test";
import assert from "node:assert/strict";
import { CASE_STATUSES, CASE_TYPES, caseChanged, caseDraft, caseStatusLabel, caseTone } from "../../src/public/admin/lib/chats.js";

test("a chat without a request starts the form at refund / received", () => {
  assert.deepEqual(caseDraft(null), { type: "refund", status: "received", note: "" });
});
test("the form starts from what is saved", () => {
  assert.deepEqual(caseDraft({ type: "exchange", status: "approved", note: "ok" }), { type: "exchange", status: "approved", note: "ok" });
});
test("save is only allowed when something differs", () => {
  const saved = { type: "refund", status: "approved", note: "5 days" };
  assert.equal(caseChanged(saved, { type: "refund", status: "approved", note: "5 days " }), false);
  assert.equal(caseChanged(saved, { type: "refund", status: "completed", note: "5 days" }), true);
  assert.equal(caseChanged(null, caseDraft(null)), true, "a first save records the request");
});
test("labels and tones cover every status the server accepts", () => {
  for (const s of CASE_STATUSES) assert.ok(caseStatusLabel(s.id) && caseTone(s.id));
  assert.deepEqual(CASE_TYPES.map((t) => t.id), ["refund", "exchange", "return", "replacement", "other"]);
  assert.equal(caseTone("rejected"), "critical");
});
