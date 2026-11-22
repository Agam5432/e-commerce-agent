// The team's side of live support, under /admin/api/support. Every call is for the one store named by the verified
// Shopify session token (req.shop); the live part (ringing, accepting, signalling) is on /support-ws.
import { Router } from "express";
import express from "express";
import * as support from "../services/supportService.js";
import * as settingsModule from "./settings.js";
import { supportHub } from "../services/supportRuntime.js";
import * as bookings from "../services/bookingService.js";
import { createConsoleTicket, exchangeConsoleTicket } from "./consoleAuth.js";

const wrap = (fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (error) {
    if (error?.status && error.status < 500) return res.status(error.status).json({ error: error.message, code: error.code });
    console.error("[admin/support] request failed:", String(error?.message || error).slice(0, 200));
    return res.status(500).json({ error: "Something went wrong. Try again." });
  }
};

const MAX_UPLOAD = () => support.MAX_RECORDING_BYTES() + 1024;

export function createSupportAdminRouter({ service = support, settings = settingsModule, hub = () => supportHub() } = {}) {
  const router = Router();

  // The first picture of live support: the team, what is waiting for this person, their own open call, and the numbers.
  router.get("/state", wrap(async (req, res) => {
    const cfg = await settings.getAgentSettings(req.shop);
    const [team, waiting, metrics, capabilities] = await Promise.all([
      service.listPresence(req.shop),
      service.waitingFor(req.shop, req.adminUser),
      service.supportMetrics(req.shop, cfg),
      service.supportCapabilities(req.shop, cfg),
    ]);
    res.json({ team, waiting, metrics, capabilities, me: req.adminUser, turnConfigured: service.turnConfigured(), recordingAllowed: capabilities.recordingAvailable });
  }));

  // Shopify's admin gives an embedded app no microphone, so calls are taken in a separate window: this is its one-time key.
  router.post("/console-ticket", wrap(async (req, res) => {
    if (req.consoleOnly) return res.status(403).json({ error: "Open the call window from the dashboard." });
    res.json({ ticket: createConsoleTicket(req.shop, req.adminUser) });
  }));

  // Online / away / offline (the dashboard also sends this as a heartbeat over the socket).
  router.post("/presence", wrap(async (req, res) => {
    const status = String(req.body?.status || "");
    if (!["online", "away", "offline"].includes(status)) return res.status(400).json({ error: "status must be online, away or offline." });
    const row = await service.setPresence(req.shop, { representativeId: req.adminUser, name: String(req.body?.name || ""), status });
    hub().broadcastPresence(req.shop);
    res.json({ presence: { id: row.representativeId, status: row.status } });
  }));

  router.get("/calls", wrap(async (req, res) => {
    const calls = await service.listCalls(req.shop, { conversationId: String(req.query.conversation || ""), chatRef: String(req.query.chatRef || ""), limit: Number(req.query.limit) || 20 });
    res.json({ items: calls });
  }));

  // The dashboard records both sides of a call the shopper agreed to save and uploads it here when the call ends.
  router.post("/calls/:id/recording", express.raw({ type: "audio/*", limit: MAX_UPLOAD() }), wrap(async (req, res) => {
    const cfg = await settings.getAgentSettings(req.shop);
    const call = await service.saveRecording(req.shop, req.params.id, { buffer: req.body, mime: req.get("Content-Type"), durationSec: Number(req.query.duration) || 0, settings: cfg });
    res.json({ call });
  }));

  router.post("/calls/:id/recording-failed", wrap(async (req, res) => {
    const call = await service.recordingFailed(req.shop, req.params.id, String(req.body?.error || "The recording could not be saved."));
    if (!call) return res.status(404).json({ error: "Call not found." });
    res.json({ call });
  }));

  // Callbacks the team has promised (a shopper asked to be called at a time): what the call window shows and sounds an alert for
  // when one is due, so nobody has to remember. Only what is needed to make the call.
  router.get("/callbacks", wrap(async (req, res) => {
    const rows = await bookings.listBookings(req.shop, { upcomingOnly: true, limit: 50 });
    const horizon = Date.now() + 36 * 3600 * 1000;
    const items = rows
      .filter((b) => ["requested", "confirmed"].includes(b.status) && new Date(b.startAt).getTime() <= horizon)
      .map((b) => ({ id: String(b._id), name: b.name || "", phone: b.phone || "", email: b.email || "", topic: b.topic || "", status: b.status, startAt: b.startAt, endAt: b.endAt, timezone: b.timezone || "" }));
    res.json({ items, now: new Date().toISOString() });
  }));

  // The call was made (or missed): it stops being due.
  router.post("/callbacks/:id/done", wrap(async (req, res) => {
    const status = req.body?.status === "missed" ? "missed" : "completed";
    const out = await bookings.closeBooking(req.shop, req.params.id, status, { note: typeof req.body?.note === "string" ? req.body.note : undefined });
    if (out.status === "not_found") return res.status(404).json({ error: "Callback not found." });
    if (out.status !== "ok") return res.status(409).json({ error: "This callback is already closed." });
    res.json({ ok: true });
  }));

  // Played in the dashboard through an authorised request: no public address exists for a recording.
  router.get("/calls/:id/recording", wrap(async (req, res) => {
    const found = await service.recordingBytes(req.shop, req.params.id);
    if (!found) return res.status(404).json({ error: "This recording is not available." });
    res.set({ "Content-Type": found.mime, "Content-Length": String(found.bytes.length), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'" });
    res.send(found.bytes);
  }));

  return router;
}

/** POST /support-console/session {ticket}: the call window swaps its one-time ticket for a session (no Shopify token needed). */
export function consoleSessionHandler({ exchange = exchangeConsoleTicket } = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json(await exchange(String(req.body?.ticket || "")));
    } catch {
      res.status(401).json({ error: "Open the call window again from your dashboard." });
    }
  };
}
