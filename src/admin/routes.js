// The store owner's dashboard API. Everything is for the one store named by the verified Shopify
// session token (req.shop): the URL and the body can never choose a store.
import { reportError } from "../observability/errors.js";
import { Router } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import StoreIntegration from "../models/StoreIntegration.js";
import { requireAdmin } from "./auth.js";
import * as stats from "./stats.js";
import * as settings from "./settings.js";
import { industryFor } from "../industries/index.js";
import { readAttachmentForOwner, attachmentBytes } from "../services/attachmentService.js";
import { DEFAULT_AGENT_NAME } from "../industries/ecommerce.js";
import { BOOKING_DEFAULTS } from "../services/bookingSettings.js";
import * as bookings from "../services/bookingService.js";
import { attention } from "./attention.js";
import { serviceAccountEmail, isCalendarConfigured } from "../services/googleCalendar.js";
import { isEmailConfigured } from "../services/emailService.js";
import * as orderInfo from "./orderDetails.js";
import { agentPerformance } from "./performance.js";
import * as handoff from "../services/handoff.js";
import { createSupportAdminRouter } from "./supportRoutes.js";
import { createComplaintAdminRouter } from "./complaintRoutes.js";
import * as callStats from "./callAnalytics.js";
import { turnConfigured } from "../services/supportService.js";
import { consoleMayReach } from "./consoleAuth.js";

/** The store as the dashboard needs to know it. */
export async function loadStore(shop) {
  const record = await StoreIntegration.findOne({ platform: "shopify", storeDomain: shop }).lean();
  return {
    shop,
    name: record?.shopName || record?.storeProfile?.name || shop,
    currency: record?.currencyCode || record?.storeProfile?.currencyCode || "",
    timezone: stats.validTimezone(record?.timezone || record?.storeProfile?.ianaTimezone || "UTC"),
    industry: record?.industry || "ecommerce",
    // Shopify refused this store's access: the dashboard shows a banner asking the owner to open the app again
    reauthRequired: Boolean(record?.reauthRequiredAt),
    reauthRequiredAt: record?.reauthRequiredAt || null,
  };
}

const BOOKING_ERRORS = {
  not_found: "That call was not found.",
  wrong_state: "This call is already closed.",
  slot_unavailable: "That time is already taken.",
  invalid: "That time is not valid.",
};

const wrap = (fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (error) {
    if (error?.status && error.status < 500) return res.status(error.status).json({ error: error.message });
    console.error("[admin] request failed:", String(error?.message || error).slice(0, 200));
    reportError(error, { scope: "admin" });
    return res.status(500).json({ error: "Something went wrong. Try again." });
  }
};

/**
 * `inline` with the shopper's file name: a plain ASCII copy for old browsers and the exact name
 * (RFC 5987, UTF-8) for the rest, so "photo 1.jpg" or "बिल.pdf" download under their own names.
 */
export function contentDisposition(name = "file") {
  const clean = String(name || "file").replace(/[\u0000-\u001f\u007f"\\/]/g, "_").slice(0, 120) || "file";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_");
  const exact = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${ascii}"; filename*=UTF-8''${exact}`;
}

export function createAdminRouter({ auth = requireAdmin(), store = loadStore, readAttachment = readAttachmentForOwner, readBytes = attachmentBytes, api = stats, config = settings, book = bookings, needsYou = attention, orders = orderInfo, perform = agentPerformance, team = handoff, limit = rateLimit({ windowMs: 60_000, limit: Number(process.env.ADMIN_RATE_LIMIT_PER_MINUTE || 240), keyGenerator: (req) => req.shop || "none", standardHeaders: true, legacyHeaders: false }) } = {}) {
  const router = Router();
  // The dashboard runs inside Shopify admin (a different origin), so browsers ask permission first.
  // Access is decided by the signed session token, never by cookies or origin, so any origin may ask.
  router.use(cors({
    origin: true,
    credentials: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "ngrok-skip-browser-warning"],
    maxAge: 600,
  }));
  router.use(auth, limit);
  // a call window's token can take calls and talk in their chat, nothing else
  router.use((req, res, next) => (req.consoleOnly && !consoleMayReach(req.method, req.path) ? res.status(403).json({ error: "This window can only take calls." }) : next()));
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // live help from a person: who is on, calls waiting, recordings (the live part is the /support-ws socket)
  router.use("/support", createSupportAdminRouter());
  router.use("/complaints", createComplaintAdminRouter());

  const context = async (req) => {
    const info = await store(req.shop);
    return { info, industry: industryFor(info.industry) };
  };

  router.get("/me", wrap(async (req, res) => {
    const { info } = await context(req);
    res.json({ ...info, user: req.adminUser });
  }));

  router.get("/overview", wrap(async (req, res) => {
    const { info, industry } = await context(req);
    res.json(await api.overview(req.shop, req.query, { analytics: industry.analytics, timezone: info.timezone, currency: info.currency }));
  }));

  // What is waiting for the owner right now (calls, follow-ups, files), whatever period the page shows.
  router.get("/attention", wrap(async (req, res) => {
    const { industry } = await context(req);
    res.json(await needsYou(req.shop, { orderedOutcome: industry.analytics?.revenue?.event || "order_placed" }));
  }));

  router.get("/conversations", wrap(async (req, res) => {
    const { info, industry } = await context(req);
    res.json(await api.listConversations(req.shop, req.query, { timezone: info.timezone, analytics: industry.analytics }));
  }));

  router.get("/conversations/:id", wrap(async (req, res) => {
    const found = await api.getConversation(req.shop, req.params.id);
    if (!found) return res.status(404).json({ error: "Conversation not found." });
    res.json(found);
  }));

  // A photo, video or PDF a shopper attached. Only this store's own files can be read; the bytes are
  // always served as a download-safe type so a file can never run as a page.
  router.get("/attachments/:id", wrap(async (req, res) => {
    const file = await readAttachment(req.shop, req.params.id);
    if (!file) return res.status(404).json({ error: "File not found." });
    const bytes = await readBytes(file);
    if (!bytes) return res.status(404).json({ error: "File not found." });
    res.setHeader("Content-Type", file.mime);
    res.setHeader("Content-Disposition", contentDisposition(file.name));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    // a shopper's file: never kept by a shared cache, never embedded by another site
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.send(bytes);
  }));

  router.patch("/conversations/:id", wrap(async (req, res) => {
    const updated = await api.updateConversation(req.shop, req.params.id, { status: req.body?.status, note: req.body?.note, case: req.body?.case, by: req.adminUser });
    if (!updated) return res.status(404).json({ error: "Conversation not found." });
    res.json(updated);
  }));

  router.post("/conversations/:id/read", wrap(async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(String(req.params.id || ""))) return res.status(404).json({ error: "Conversation not found." });
    if (!(await api.markConversationRead(req.shop, req.params.id))) return res.status(404).json({ error: "Conversation not found." });
    res.json({ ok: true });
  }));

  // ---- the team talks to the shopper ------------------------------------------------------------
  const chatId = (req) => {
    if (!/^[a-f0-9]{24}$/i.test(String(req.params.id || ""))) throw Object.assign(new Error("Conversation not found."), { status: 404 });
    return req.params.id;
  };
  router.post("/conversations/:id/reply", wrap(async (req, res) => {
    const sent = await team.sendStaffReply(req.shop, chatId(req), { text: req.body?.text, by: req.adminUser });
    res.json({ at: sent.at, handoff: { active: true } });
  }));
  router.post("/conversations/:id/handoff", wrap(async (req, res) => {
    if (typeof req.body?.active !== "boolean") return res.status(400).json({ error: "active must be true or false." });
    const chat = await team.setHandoff(req.shop, chatId(req), { active: req.body.active, by: req.adminUser });
    res.json({ handoff: { active: Boolean(chat.handoff?.active) } });
  }));

  // ---- call bookings ---------------------------------------------------------------------------
  const bookingContext = async (req) => {
    const { info } = await context(req);
    return { settings: await settingsFor(config, req.shop), shopName: info.name };
  };
  const answer = (res, out) => {
    const codes = { not_found: 404, wrong_state: 409, slot_unavailable: 409, invalid: 400 };
    if (out.status !== "ok") return res.status(codes[out.status] || 400).json({ error: BOOKING_ERRORS[out.status] || "Could not do that.", status: out.status });
    return res.json({ booking: stats.bookingView(out.booking) });
  };

  router.get("/bookings", wrap(async (req, res) => {
    const rows = await book.listBookings(req.shop, { status: req.query.status, conversationId: req.query.conversationId, personKey: req.query.person, upcomingOnly: req.query.upcoming === "1" });
    res.json({ items: rows.map(stats.bookingView) });
  }));

  // Free times the owner can move a call to (the same hours the AI offers).
  router.get("/bookings/slots", wrap(async (req, res) => {
    const { slots, timezone } = await book.listFreeSlots({ shop: req.shop, settings: await settingsFor(config, req.shop), limit: 12, perDay: 6 });
    res.json({ timezone, slots });
  }));

  router.post("/bookings/:id/confirm", wrap(async (req, res) => {
    const { settings: cfg, shopName } = await bookingContext(req);
    answer(res, await book.confirmBooking(req.shop, req.params.id, { settings: cfg, shopName }));
  }));

  router.post("/bookings/:id/reschedule", wrap(async (req, res) => {
    const { settings: cfg, shopName } = await bookingContext(req);
    answer(res, await book.rescheduleBooking(req.shop, req.params.id, { startAt: req.body?.startAt, settings: cfg, shopName }));
  }));

  router.post("/bookings/:id/close", wrap(async (req, res) => {
    const { settings: cfg } = await bookingContext(req);
    answer(res, await book.closeBooking(req.shop, req.params.id, req.body?.status, { note: req.body?.note, settings: cfg }));
  }));

  router.get("/customers", wrap(async (req, res) => {
    const { info, industry } = await context(req);
    res.json(await api.listCustomers(req.shop, req.query, { analytics: industry.analytics, timezone: info.timezone, currency: info.currency }));
  }));

  router.get("/customers/:id", wrap(async (req, res) => {
    const { info, industry } = await context(req);
    const found = await api.getCustomer(req.shop, req.params.id, { analytics: industry.analytics, currency: info.currency });
    if (!found) return res.status(404).json({ error: "Customer not found." });
    res.json(found);
  }));

  // Calls: counts for the overview, customer and employee views, a filtered list, and one call with who handled it.
  router.get("/call-analytics", wrap(async (req, res) => {
    const { info } = await context(req);
    const range = stats.parseRange(req.query, info.timezone);
    const cfg = await config.getAgentSettings(req.shop);
    res.json(await callStats.storeCallAnalytics(req.shop, range, { retentionDays: settings.retentionDaysFor(cfg), timezone: info.timezone }));
  }));

  router.get("/call-log", wrap(async (req, res) => {
    const { info } = await context(req);
    const hasRange = req.query.from || req.query.to;
    const range = hasRange ? stats.parseRange(req.query, info.timezone) : null;
    res.json(await callStats.listSupportCalls(req.shop, {
      person: String(req.query.person || ""), handler: String(req.query.handler || ""), outcome: String(req.query.outcome || ""),
      from: range?.start || null, to: range?.end || null, offset: Number(req.query.cursor) || 0, limit: Number(req.query.limit) || 25,
    }));
  }));

  router.get("/call-log/:id", wrap(async (req, res) => {
    const found = await callStats.getSupportCall(req.shop, req.params.id);
    if (!found) return res.status(404).json({ error: "Call not found." });
    res.json(found);
  }));

  router.delete("/customers/:id", wrap(async (req, res) => {
    const done = await api.erasePerson(req.shop, req.params.id);
    if (!done) return res.status(404).json({ error: "Customer not found." });
    res.json(done);
  }));

  router.get("/orders", wrap(async (req, res) => {
    const { info, industry } = await context(req);
    const page = await api.listOrders(req.shop, req.query, { analytics: industry.analytics, timezone: info.timezone });
    // payment and delivery status live in Shopify; if it is slow or refuses, the rows simply have none
    const found = await orders.orderStatuses(req.shop, page.items.map((o) => o.orderName));
    res.json({ ...page, items: page.items.map((o) => ({ ...o, status: found[String(o.orderName || "").match(/(\d+)\s*$/)?.[1]] || null })) });
  }));

  router.get("/orders/:name", wrap(async (req, res) => {
    const { industry } = await context(req);
    try {
      const found = await orders.orderDetails(req.shop, req.params.name, { analytics: industry.analytics });
      if (!found) return res.status(404).json({ error: "Order not found." });
      res.json(found);
    } catch (error) {
      if (error instanceof orders.OrderLookupError) return res.status(error.status).json({ error: error.message });
      throw error;
    }
  }));

  router.get("/performance", wrap(async (req, res) => {
    const { info, industry } = await context(req);
    res.json(await perform(req.shop, req.query, { analytics: industry.analytics, timezone: info.timezone }));
  }));

  router.get("/settings", wrap(async (req, res) => {
    const { industry, info } = await context(req);
    res.json({
      settings: await settingsFor(config, req.shop),
      options: {
        configurableTools: industry.admin?.configurableTools || [],
        defaultAgentName: DEFAULT_AGENT_NAME,
        defaultRetentionDays: settings.DEFAULT_RETENTION_DAYS,
        // what the owner has to do outside the app for calls to reach their calendar and inbox
        calendar: { configured: isCalendarConfigured(), shareWith: serviceAccountEmail() },
        emailConfigured: isEmailConfigured(),
        // live help: whether audio can be relayed across strict networks (TURN) is a server setting, not the owner's
        support: { turnConfigured: turnConfigured() },
        bookingDefaults: { ...BOOKING_DEFAULTS, timezone: info.timezone },
      },
    });
  }));

  router.put("/settings", wrap(async (req, res) => {
    const { industry } = await context(req);
    try {
      const result = await config.saveAgentSettings(req.shop, req.body?.settings, {
        by: req.adminUser,
        expectedVersion: req.body?.expectedVersion ?? null,
        configurableTools: industry.admin?.configurableTools || [],
        validateIndustry: industry.admin?.validateSettings || null,
      });
      if (!result.ok) return res.status(400).json({ errors: result.errors });
      res.json({ settings: result.settings, changed: result.changed });
    } catch (error) {
      if (error?.name === "SettingsConflictError") return res.status(409).json({ error: error.message });
      throw error;
    }
  }));

  router.get("/settings/history", wrap(async (req, res) => {
    res.json({ history: await config.getSettingsHistory(req.shop) });
  }));

  return router;
}

// A fresh read for the settings screen (the agent itself uses the cached copy).
async function settingsFor(config, shop) {
  config.invalidateSettings?.(shop);
  return config.getAgentSettings(shop);
}