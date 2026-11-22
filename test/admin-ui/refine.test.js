import test from "node:test";
import assert from "node:assert/strict";
import { chatRow, chatState, requestTag } from "../../src/public/admin/lib/chats.js";
import { SETTINGS_TABS, tabForError } from "../../src/public/admin/lib/settingsForm.js";

const chat = (o = {}) => ({ id: "1", status: "open", channel: "text", flags: {}, contact: {}, ...o });

test("a chat has ONE status in the owner's words", () => {
  assert.deepEqual(chatState(chat()), { id: "ai", label: "AI handling", tone: "neutral" });
  assert.equal(chatState(chat({ flags: { needsFollowUp: true } })).label, "Waiting on you");
  assert.equal(chatState(chat({ flags: { callRequested: true } })).label, "Waiting on you");
  assert.equal(chatState(chat({ status: "needs_human" })).label, "Waiting on you");
  assert.equal(chatState(chat({ flags: { needsFollowUp: true }, handoff: { active: true } })).label, "With a person");
  assert.equal(chatState(chat({ flags: { needsFollowUp: true }, handoff: { active: true }, status: "resolved" })).label, "Resolved");
});

test("a refund or exchange is a tag next to the status, not a second status", () => {
  assert.equal(requestTag(chat()), null);
  assert.deepEqual(requestTag(chat({ case: { type: "refund", status: "in_progress" } })), { text: "Refund · In progress", tone: "caution" });
  assert.equal(requestTag(chat({ case: { type: "exchange", status: "approved" } })).tone, "success");
  assert.equal(requestTag(chat({ case: { type: "return", status: "rejected" } })).tone, "critical");
});

test("a row carries its status, request and the reason it needs the owner", () => {
  const row = chatRow(chat({ flags: { needsFollowUp: true, reason: "  Broken TV, photo sent " }, case: { type: "replacement", status: "received" } }));
  assert.equal(row.state.label, "Waiting on you");
  assert.equal(row.request.text, "Replacement · Received");
  assert.equal(row.reason, "Broken TV, photo sent");
});

test("every settings section is in exactly one tab", () => {
  const all = ["talks", "qa", "may", "alerts", "files", "privacy", "history"];
  const placed = SETTINGS_TABS.flatMap((t) => t.sections);
  assert.deepEqual([...placed].sort(), [...all].sort());
});

test("saving with a problem opens the tab that holds it", () => {
  assert.equal(tabForError("name"), "behaviour");
  assert.equal(tabForError("instructions"), "behaviour");
  assert.equal(tabForError("knowledge"), "knowledge");
  assert.equal(tabForError("question-2"), "knowledge");
  assert.equal(tabForError("answer-0"), "knowledge");
  assert.equal(tabForError("retentionDays"), "privacy");
  assert.equal(tabForError("callDays"), "rules");
  assert.equal(tabForError("notificationEmail"), "rules");
});
