// HTTP production safeguards: security headers, health/readiness probes, per-shopper rate limits
// and graceful shutdown. Kept separate from server.js so each piece is unit-tested.
import rateLimit from "express-rate-limit";
import { createSharedRateLimitStore } from "./rateLimitStore.js";
import { inc } from "../observability/metrics.js";
import { alert } from "../observability/alerts.js";

/**
 * Conservative headers that are safe for an app embedded in Shopify Admin (no X-Frame-Options:
 * Shopify Admin frames the app; framing is restricted with CSP frame-ancestors instead).
 */
export function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(self)");
  res.setHeader("Content-Security-Policy", "frame-ancestors https://*.myshopify.com https://admin.shopify.com;");
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  res.removeHeader("X-Powered-By");
  next();
}

const startedAt = Date.now();

/** /healthz = the process is alive. /readyz = it can serve customers (database connected). */
export function createHealthHandlers({ mongoose, isShuttingDown = () => false } = {}) {
  return {
    liveness(req, res) {
      res.set("Cache-Control", "no-store");
      res.json({ status: "ok", uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
    },
    readiness(req, res) {
      res.set("Cache-Control", "no-store");
      const dbReady = mongoose?.connection?.readyState === 1;
      const ready = dbReady && !isShuttingDown();
      res.status(ready ? 200 : 503).json({
        status: ready ? "ready" : "not_ready",
        database: dbReady ? "connected" : "disconnected",
        shuttingDown: isShuttingDown(),
      });
    },
  };
}

/** A whole number from the environment; an empty or invalid value keeps the default. 0 is allowed (it turns a cap off). */
export function envCount(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/**
 * The network a shopper is on. IPv4: the address. IPv6: its /64, because one home or phone gets a whole /64
 * and could otherwise take a new address for every request.
 */
export function ipBucket(ip = "") {
  const raw = String(ip).trim().toLowerCase().replace(/%.*$/, "");
  const v4 = raw.match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) return v4[1];
  if (!raw.includes(":")) return raw || "unknown";
  const [head, tail = ""] = raw.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = raw.includes("::") ? [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back] : front;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "") || "0").join(":")}::/64`;
}

/**
 * Who a per-shopper limit counts against. Only things the shopper cannot invent are used: the signed
 * Shopify customer id when they are logged in, otherwise their network (req.ip, set by TRUST_PROXY_HOPS).
 * The browser's clientId is never part of the key: a new one on every request would get around the limit.
 */
export function visitorIdentity(req) {
  const customer = String(req.proxyCustomerId || req.uploadCustomerId || "").replace(/\D/g, "").slice(0, 30);
  return customer ? `customer:${customer}` : `net:${ipBucket(req.ip)}`;
}

/**
 * On routes the browser calls directly (uploads), the shopper is the one the App Proxy saw when it
 * issued the token (`req.tokenVisitor`): a header the browser sends there cannot change who is counted.
 */
export function visitorKey(req) {
  const shop = String(req.verifiedShop || "").toLowerCase().slice(0, 120) || "unverified";
  const fromToken = /^(?:customer:\d{1,30}|net:[0-9a-f:./]{1,48})$/i.test(String(req.tokenVisitor || "")) ? req.tokenVisitor : "";
  const key = `${shop}|${fromToken || visitorIdentity(req)}`;
  // RATE_LIMIT_DEBUG=1: shows which "visitor" each request is counted as. If the same shopper shows up under
  // different keys (TRUST_PROXY_HOPS too low), the limit never fills: set the hop count so the key is stable.
  if (process.env.RATE_LIMIT_DEBUG === "1") console.log(`[rate] key=${key} ip=${req.ip} hops=${process.env.TRUST_PROXY_HOPS ?? 1} xff=${String(req.headers?.["x-forwarded-for"] || "").slice(0, 120)}`);
  return key;
}

const tooFast = (req, res, _next, options) => {
  const retryAfterSeconds = Math.max(1, Math.ceil((req.rateLimit?.resetTime?.getTime?.() - Date.now()) / 1000) || Math.ceil(options.windowMs / 1000));
  return res.status(429).json({ error: "Too many requests from this shopper. Please wait and try again.", code: "rate_limited", retryAfterSeconds });
};

/** Rate limit per shop + shopper, so one shopper cannot run up the store's AI bill. */
export function createChatRateLimiter({
  name = "chat",
  windowMs = envCount("CHAT_RATE_WINDOW_MS", 60_000) || 60_000,
  limit = envCount("CHAT_RATE_LIMIT", 30) || 30,
  store = createSharedRateLimitStore({ prefix: `visitor:${name}:` }),
} = {}) {
  return rateLimit({
    windowMs,
    limit,
    store,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: visitorKey,
    handler: tooFast,
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A ceiling for one whole store, whoever is asking: per minute and per day. This is what keeps the bill
 * bounded even if someone spreads requests over many networks. The shop comes only from Shopify's signature.
 * A limit of 0 turns that ceiling off. One budget can be put on several routes; they then share the count.
 */
export function createShopBudget({
  name = "ai",
  perMinute = envCount("SHOP_AI_RATE_LIMIT_PER_MINUTE", 240),
  perDay = envCount("SHOP_AI_LIMIT_PER_DAY", 15000),
  storeFor = (window) => createSharedRateLimitStore({ prefix: `shop:${name}:${window}:` }),
  log = console,
} = {}) {
  const ceiling = (window, windowMs, limit) =>
    rateLimit({
      windowMs,
      limit,
      store: storeFor(window),
      standardHeaders: false,
      legacyHeaders: false,
      keyGenerator: (req) => String(req.verifiedShop || "").toLowerCase().slice(0, 120) || "unverified",
      handler: (req, res, _next, options) => {
        log.warn?.(`[rate-limit] ${req.verifiedShop || "unknown shop"} reached its ${name} limit of ${limit} per ${window}`);
        inc("shop_budget_reached_total", { budget: name, window }, 1, "Requests refused because a store reached its ceiling");
        alert(`budget:${req.verifiedShop}:${name}:${window}`, `${req.verifiedShop} reached its ${name} limit of ${limit} per ${window}; its shoppers are told to try later. Raise SHOP_${name === "ai" ? "AI" : "UPLOAD"}_* if this is real traffic.`);
        const retryAfterSeconds = Math.max(1, Math.ceil((req.rateLimit?.resetTime?.getTime?.() - Date.now()) / 1000) || Math.ceil(options.windowMs / 1000));
        return res.status(429).json({ error: "This store's assistant is busy right now. Please try again later.", code: "store_busy", retryAfterSeconds });
      },
    });
  const layers = [];
  if (perMinute > 0) layers.push(ceiling("minute", 60_000, perMinute));
  if (perDay > 0) layers.push(ceiling("day", DAY_MS, perDay));
  return layers;
}

/**
 * On SIGTERM/SIGINT: stop accepting work, let in-flight requests finish, close sockets and the
 * database, then exit. A hard timeout guarantees the process exits.
 */
export function installGracefulShutdown({ server, wss, mongoose, log = console, timeoutMs = 10_000, exit = process.exit } = {}) {
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info?.(`[shutdown] ${signal} received: draining connections`);
    const hardStop = setTimeout(() => {
      log.error?.("[shutdown] timed out; forcing exit");
      exit(1);
    }, timeoutMs);
    hardStop.unref?.();
    try {
      for (const client of wss?.clients || []) {
        try {
          client.close(1001, "Server restarting");
        } catch {
          /* ignore */
        }
      }
      await new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
      if (mongoose?.connection?.readyState === 1) await mongoose.disconnect();
      clearTimeout(hardStop);
      // a crash is not a clean stop: a supervisor that restarts only on failure must see a non-zero code
      exit(signal === "uncaughtException" ? 1 : 0);
    } catch (error) {
      log.error?.(`[shutdown] failed: ${error?.message || error}`);
      exit(1);
    }
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  return { isShuttingDown: () => shuttingDown, shutdown };
}