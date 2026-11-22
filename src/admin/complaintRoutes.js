// The store's side of customer complaints, under /admin/api/complaints. The store always comes from the verified Shopify
// session token (req.shop): a complaint of another store is never found, listed, changed or settled here.
import { Router } from "express";
import * as complaints from "../services/complaintService.js";
import * as settingsModule from "./settings.js";

const wrap = (fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (error) {
    if (error?.status && error.status < 500) return res.status(error.status).json({ error: error.message, code: error.code });
    console.error("[admin/complaints] request failed:", String(error?.message || error).slice(0, 200));
    return res.status(500).json({ error: "Something went wrong. Try again." });
  }
};

export function createComplaintAdminRouter({ service = complaints, settings = settingsModule } = {}) {
  const router = Router();

  // The list, newest first. `?open=1` only the ones not settled yet; `?status=email_failed` and so on.
  router.get("/", wrap(async (req, res) => {
    const open = req.query.open === "1" ? true : req.query.open === "0" ? false : null;
    const rows = await service.listComplaints(req.shop, { status: String(req.query.status || ""), open, limit: Number(req.query.limit) || 50 });
    const all = await service.listComplaints(req.shop, { open: true, limit: 200 });
    res.json({
      items: rows.map(service.complaintView),
      counts: {
        open: all.length,
        emailFailed: all.filter((c) => ["failed", "not_configured", "retrying"].includes(c.email?.status)).length,
        waitingForPerson: all.filter((c) => ["requested", "unavailable"].includes(c.handoff?.status)).length,
      },
    });
  }));

  router.get("/:id", wrap(async (req, res) => {
    const found = await service.getComplaint(req.shop, req.params.id);
    if (!found) return res.status(404).json({ error: "Complaint not found." });
    res.json({ complaint: service.complaintView(found) });
  }));

  // The email did not go (or the store set up its support email afterwards): try it again. An email already sent is never sent twice.
  router.post("/:id/retry-email", wrap(async (req, res) => {
    const found = await service.getComplaint(req.shop, req.params.id);
    if (!found) return res.status(404).json({ error: "Complaint not found." });
    if (!found.open) return res.status(409).json({ error: "This complaint is already settled." });
    if (found.channel !== "email" && found.email?.status !== "failed" && found.email?.status !== "not_configured") return res.status(409).json({ error: "This complaint was not meant to be emailed." });
    const cfg = await settings.getAgentSettings(req.shop);
    const out = await service.escalate({ shop: req.shop, chatRef: found.chatRef, channel: "email", issue: {}, settings: cfg, language: found.language });
    res.json({ status: out.status, complaint: out.complaint });
  }));

  router.post("/:id/resolve", wrap(async (req, res) => {
    const done = await service.resolveComplaint(req.shop, req.params.id, String(req.adminUser || ""));
    if (!done) return res.status(404).json({ error: "Complaint not found." });
    res.json({ complaint: service.complaintView(done) });
  }));

  return router;
}
