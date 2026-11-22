// The call window. Shopify's admin does not let an embedded app use the microphone (it adds no `allow` permission to the
// app's iframe), so a team member takes calls in a small separate browser window instead. That window is not inside
// Shopify, so it has no App Bridge session token. The signed-in dashboard hands it a one-time ticket (made from the
// verified session token); the window swaps the ticket for a session of its own, bound to the same store and person.
//
//   dashboard (verified session token) -> POST /admin/api/support/console-ticket -> ticket (2 minutes, usable once)
//   call window                         -> POST /support-console/session {ticket} -> console token (a work shift long)
//
// A console token can do only what taking calls needs (see CONSOLE_ALLOWED): it cannot read orders or change settings.
import crypto from "node:crypto";
import { tokenReplayGuard } from "../services/tokenReplay.js";
import { isActiveStore, normalizeShopDomain } from "../services/storeIntegrationService.js";

const SHOP = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const TICKET_TTL_S = 120;
const SESSION_TTL_S = () => (Number(process.env.SUPPORT_CONSOLE_HOURS) > 0 ? Number(process.env.SUPPORT_CONSOLE_HOURS) : 10) * 3600;

const secret = () => process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET || "";
const key = (label) => crypto.createHmac("sha256", secret()).update(`support-console-${label}-v1`).digest();
const sign = (label, payload) => crypto.createHmac("sha256", key(label)).update(payload).digest("base64url");

function make(label, claims, ttlSeconds, now = Date.now()) {
  if (!secret()) throw new Error("SHOPIFY_CLIENT_SECRET is not configured.");
  const body = Buffer.from(JSON.stringify({ ...claims, k: label, jti: crypto.randomBytes(16).toString("base64url"), exp: Math.floor(now / 1000) + ttlSeconds })).toString("base64url");
  return `${body}.${sign(label, body)}`;
}

function read(label, token, now = Date.now()) {
  if (typeof token !== "string" || token.length > 1024) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined || !secret()) return null;
  try {
    const expected = Buffer.from(sign(label, body));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (c.k !== label || !SHOP.test(c.shop || "") || !/^[\w-]{1,60}$/.test(String(c.user || "")) || !Number.isSafeInteger(c.exp) || c.exp < Math.floor(now / 1000)) return null;
    return { shop: c.shop, userId: String(c.user), jti: String(c.jti || ""), exp: c.exp };
  } catch {
    return null;
  }
}

/** A one-time ticket for the call window, made from an already verified dashboard session. */
export const createConsoleTicket = (shop, userId, now) => make("ticket", { shop: normalizeShopDomain(shop), user: String(userId) }, TICKET_TTL_S, now);
const createConsoleSession = (shop, userId, now) => make("session", { shop, user: userId }, SESSION_TTL_S(), now);

/** The verified identity of a console session token, or null. */
export const verifyConsoleToken = (token, now) => read("session", token, now);

/** Swaps a ticket for a session. Throws Error("invalid_ticket") for anything wrong, used or expired. */
export async function exchangeConsoleTicket(ticket, { guard = tokenReplayGuard(), active = isActiveStore, now } = {}) {
  const claims = read("ticket", ticket, now);
  if (!claims || !claims.jti) throw new Error("invalid_ticket");
  if (!(await guard.consume(`console:${claims.jti}`, claims.exp))) throw new Error("invalid_ticket");
  if (!(await active(claims.shop))) throw new Error("invalid_ticket");
  return { token: createConsoleSession(claims.shop, claims.userId, now), shop: claims.shop, userId: claims.userId, expiresInSeconds: SESSION_TTL_S() };
}

/** What a console token may reach on /admin/api: taking calls, reading the chat of a call, replying in it. */
export const CONSOLE_ALLOWED = [
  { method: "GET", path: /^\/support\/(state|calls)$/ },
  { method: "POST", path: /^\/support\/presence$/ },
  // the callbacks the team promised: shown in the call window, with an alert when one is due
  { method: "GET", path: /^\/support\/callbacks$/ },
  { method: "POST", path: /^\/support\/callbacks\/[a-f0-9]{24}\/done$/ },
  { method: "POST", path: /^\/support\/calls\/[a-f0-9]{24}\/recording(-failed)?$/ },
  { method: "GET", path: /^\/conversations\/[a-f0-9]{24}$/ },
  { method: "POST", path: /^\/conversations\/[a-f0-9]{24}\/reply$/ },
];
export const consoleMayReach = (method, path) => CONSOLE_ALLOWED.some((r) => r.method === method && r.path.test(path));
