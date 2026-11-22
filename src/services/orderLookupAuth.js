/**
 * Email-OTP verification for guest order-status lookups.
 *
 * Rules (as requested by the store owner):
 *  - Email must be a valid address (same validator the checkout uses).
 *  - A 6-digit code is emailed. Only a code of exactly 6 digits is accepted;
 *    4, 5, 7... digits are rejected as "invalid format" (the code stays alive).
 *  - A WRONG 6-digit code cancels that OTP immediately. The customer must ask
 *    for a new one (resend) before trying again.
 *  - A code expires after 10 minutes and works only once.
 *  - After a correct code the email stays "verified" on this device (shop + clientId)
 *    for as long as the chat lives: 30 days, renewed on every use (same lifetime as the
 *    guest chat history in the widget). When the chat is cleared/reset (or the chat has
 *    expired) the verification is removed too and the shopper verifies again.
 *    Logged-in Shopify customers never need this.
 *
 * Security notes: codes are never stored in plain text (HMAC), never returned to
 * the AI, and never logged in production. Sends are rate limited per email and
 * per browser so the store mailbox cannot be used to spam strangers.
 */
import crypto from "node:crypto";
import mongoose from "mongoose";
import { validateEmail } from "./contactValidation.js";
import { sendOtpEmail, isEmailConfigured as emailConfigured } from "./emailService.js";
import OrderLookupSession from "../models/OrderLookupSession.js";

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60 * 1000;
// How long a verified email keeps working on one device, renewed on every use. Short, because the
// browser's chat id is what holds it, and other scripts on the storefront page can read that id.
const verifiedDays = Number(process.env.ORDER_LOOKUP_VERIFIED_DAYS);
export const VERIFIED_TTL_MS = (Number.isFinite(verifiedDays) && verifiedDays > 0 ? verifiedDays : 1) * 24 * 60 * 60 * 1000;
export const CANCEL_PENDING_TTL_MS = 15 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 30 * 1000;
export const SEND_WINDOW_MS = 60 * 60 * 1000;
export const MAX_SENDS_PER_EMAIL = 5;
export const MAX_SENDS_PER_CLIENT = 8;
const SESSION_TTL_MS = VERIFIED_TTL_MS + 24 * 60 * 60 * 1000;

const DIGIT_WORDS = {
  zero: "0", shunya: "0", sunya: "0",
  one: "1", ek: "1",
  two: "2", do: "2", dho: "2",
  three: "3", teen: "3", tin: "3",
  four: "4", char: "4", chaar: "4", chār: "4",
  five: "5", paanch: "5", panch: "5", pach: "5",
  six: "6", chhe: "6", che: "6", chhah: "6", chah: "6", chhai: "6",
  seven: "7", saat: "7", sat: "7",
  eight: "8", aath: "8", ath: "8",
  nine: "9", nau: "9", nav: "9",
};

/**
 * Turns whatever the shopper typed/said into a digit string.
 * "482 913", "4-8-2-9-1-3", "४८२९१३" and (voice) "four eight two nine one three" all become digits.
 */
export function normalizeOtpInput(raw) {
  let text = String(raw ?? "").trim();
  // Devanagari digits -> ASCII
  text = text.replace(/[\u0966-\u096F]/g, (ch) => String(ch.charCodeAt(0) - 0x0966));
  if (/\d/.test(text)) return text.replace(/\D/g, "");
  const words = text.toLowerCase().split(/[^a-zāēīōū]+/i).filter(Boolean);
  if (words.length && words.every((w) => w in DIGIT_WORDS)) {
    return words.map((w) => DIGIT_WORDS[w]).join("");
  }
  return "";
}

export function maskEmail(email) {
  const [user, domain] = String(email || "").split("@");
  if (!user || !domain) return "***";
  return `${user.slice(0, Math.min(2, user.length))}***@${domain}`;
}

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function secretKey() {
  return (
    process.env.OTP_HMAC_SECRET ||
    process.env.TOKEN_ENCRYPTION_KEY ||
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY ||
    process.env.SHOPIFY_CLIENT_SECRET ||
    process.env.SHOPIFY_API_SECRET ||
    fallbackSecret
  );
}
// Per-process random fallback: codes then simply stop working after a restart (safe default).
const fallbackSecret = crypto.randomBytes(32).toString("hex");

function hashCode(shop, clientId, email, code) {
  return crypto
    .createHmac("sha256", secretKey())
    .update([shop, clientId, email, code].join("|"))
    .digest("hex");
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ""), "hex");
  const y = Buffer.from(String(b || ""), "hex");
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

const normShop = (shop) => String(shop || "").toLowerCase().trim();
const normClient = (clientId) => String(clientId || "anon").slice(0, 64);

/** MongoDB-backed key/value store (rows expire automatically). */
export function createMongoStore(Model = OrderLookupSession) {
  return {
    async get(key) {
      // No DB connection (tests / outage): behave as "nothing stored" instead of hanging on buffered queries.
      if (mongoose.connection.readyState !== 1) return null;
      const row = await Model.findOne({ key, expiresAt: { $gt: new Date() } }).lean();
      return row?.data || null;
    },
    async set(key, data, ttlMs = SESSION_TTL_MS) {
      await Model.findOneAndUpdate(
        { key },
        { $set: { data, expiresAt: new Date(Date.now() + ttlMs) }, $setOnInsert: { key } },
        { upsert: true }
      );
    },
    async delete(key) {
      await Model.deleteOne({ key });
    },
  };
}

/** In-memory store (tests / local experiments). */
export function createMemoryStore(now = Date.now) {
  const rows = new Map();
  return {
    rows,
    async get(key) {
      const row = rows.get(key);
      if (!row || row.expiresAt <= now()) return null;
      return JSON.parse(JSON.stringify(row.data));
    },
    async set(key, data, ttlMs = SESSION_TTL_MS) {
      rows.set(key, { data: JSON.parse(JSON.stringify(data)), expiresAt: now() + ttlMs });
    },
    async delete(key) {
      rows.delete(key);
    },
  };
}

/**
 * Where this flow keeps its rows: one per visitor ("ol:") and one OTP send counter per email ("olr:").
 * Exported so a privacy erase can find exactly the rows of one store or one customer.
 */
export const orderLookupKeys = {
  sessionPrefix: (shop) => `ol:${normShop(shop)}:`,
  sessionKey: (shop, clientId) => `ol:${normShop(shop)}:${normClient(clientId)}`,
  emailPrefix: (shop) => `olr:${normShop(shop)}:`,
  emailKey: (shop, email) =>
    `olr:${normShop(shop)}:${crypto.createHash("sha256").update(normalizeEmail(email)).digest("hex").slice(0, 32)}`,
};

export function createOrderLookupAuth({
  store,
  sendEmail = sendOtpEmail,
  isEmailConfigured = emailConfigured,
  now = Date.now,
  generateCode = () => String(crypto.randomInt(10 ** (OTP_LENGTH - 1), 10 ** OTP_LENGTH)),
  // Printing codes to the console (no mailbox configured) is for local development only.
  devLog = process.env.NODE_ENV !== "production" && process.env.ENABLE_DEV_ROUTES === "1",
} = {}) {
  const kv = store || createMongoStore();
  const { sessionKey, emailKey } = orderLookupKeys;
  const recent = (list) => (Array.isArray(list) ? list : []).filter((t) => now() - t < SEND_WINDOW_MS);

  /**
   * Sends (or re-sends) a code. `email` may be omitted to resend to the email
   * that is currently being verified on this device.
   */
  async function requestOtp({ shop, clientId, email, shopName }) {
    const key = sessionKey(shop, clientId);
    const session = (await kv.get(key)) || {};
    const target = normalizeEmail(email || session.email);

    if (!target) return { status: "email_required" };
    const check = validateEmail(target);
    if (!check.ok) return { status: "invalid_email", reason: check.reason };

    const configured = Boolean(isEmailConfigured());
    if (!configured && !devLog) return { status: "email_unavailable" };

    const sameEmail = session.email === target;
    const otpAlive = session.otpStatus === "active" && session.otpExpiresAt > now();
    if (sameEmail && otpAlive && session.sentAt && now() - session.sentAt < RESEND_COOLDOWN_MS) {
      return {
        status: "cooldown",
        secondsLeft: Math.max(1, Math.ceil((RESEND_COOLDOWN_MS - (now() - session.sentAt)) / 1000)),
      };
    }

    const clientSends = recent(session.sends);
    const eKey = emailKey(shop, target);
    const emailRow = (await kv.get(eKey)) || {};
    const emailSends = recent(emailRow.sends);
    if (clientSends.length >= MAX_SENDS_PER_CLIENT || emailSends.length >= MAX_SENDS_PER_EMAIL) {
      return { status: "rate_limited" };
    }

    const code = generateCode();
    const next = {
      ...session,
      email: target,
      otpHash: hashCode(normShop(shop), normClient(clientId), target, code),
      otpExpiresAt: now() + OTP_TTL_MS,
      otpStatus: "active",
      sentAt: now(),
      sends: [...clientSends, now()],
    };

    if (configured) {
      const sent = await sendEmail({ to: target, code, shopName, purpose: "order_lookup" });
      if (!sent?.ok) return { status: "send_failed" };
    } else {
      // Local development only (no mailbox configured): print the code in the server console.
      console.log(`[order-otp][DEV ONLY] ${target} -> ${code}`);
    }

    await kv.set(key, next);
    await kv.set(eKey, { sends: [...emailSends, now()] }, SEND_WINDOW_MS);

    return {
      status: "otp_sent",
      maskedEmail: maskEmail(target),
      digits: OTP_LENGTH,
      expiresInMinutes: Math.round(OTP_TTL_MS / 60000),
    };
  }

  async function verifyOtp({ shop, clientId, code }) {
    const key = sessionKey(shop, clientId);
    const session = await kv.get(key);
    if (!session?.otpHash || !session.otpStatus) return { status: "no_otp_pending" };

    if (session.otpStatus === "invalidated") return { status: "otp_invalidated" };
    if (!(session.otpExpiresAt > now())) {
      await kv.set(key, { ...session, otpStatus: "invalidated" });
      return { status: "expired" };
    }

    const digits = normalizeOtpInput(code);
    if (digits.length !== OTP_LENGTH) {
      // Not a real attempt: wrong length. The code stays valid so they can retry.
      return { status: "invalid_format", enteredDigits: digits.length, expectedDigits: OTP_LENGTH };
    }

    const ok = safeEqualHex(
      hashCode(normShop(shop), normClient(clientId), session.email, digits),
      session.otpHash
    );

    if (!ok) {
      // A wrong 6-digit code burns this OTP: a new one must be requested.
      await kv.set(key, { ...session, otpStatus: "invalidated" });
      return { status: "wrong_otp" };
    }

    await kv.set(key, {
      ...session,
      otpHash: null,
      otpStatus: null,
      otpExpiresAt: null,
      verifiedEmail: session.email,
      verifiedUntil: now() + VERIFIED_TTL_MS,
    });
    return { status: "verified", email: session.email, maskedEmail: maskEmail(session.email) };
  }

  async function getVerifiedEmail({ shop, clientId }) {
    const session = await kv.get(sessionKey(shop, clientId));
    if (session?.verifiedEmail && session.verifiedUntil > now()) {
      // Sliding window: every use keeps the verification alive as long as the chat is active.
      await kv.set(sessionKey(shop, clientId), { ...session, verifiedUntil: now() + VERIFIED_TTL_MS });
      return session.verifiedEmail;
    }
    return null;
  }

  /**
   * Called when the shopper's chat is cleared/reset (or expired): forgets the verified email and
   * the order being discussed. OTP send counters are kept so a reset cannot be used to bypass rate limits.
   */
  async function clearVerification({ shop, clientId }) {
    const key = sessionKey(shop, clientId);
    const session = await kv.get(key);
    if (!session) return;
    await kv.set(key, {
      ...session,
      verifiedEmail: null,
      verifiedUntil: null,
      otpHash: null,
      otpStatus: null,
      otpExpiresAt: null,
      pendingCancel: null,
      lastOrderNumber: "",
    });
  }

  // ---- order-cancellation conversation state (confirm -> reason -> cancel) ----
  async function setPendingCancel({ shop, clientId, pending }) {
    const key = sessionKey(shop, clientId);
    const session = (await kv.get(key)) || {};
    await kv.set(key, { ...session, pendingCancel: { ...pending, at: now() } });
  }

  async function getPendingCancel({ shop, clientId }) {
    const session = await kv.get(sessionKey(shop, clientId));
    const pending = session?.pendingCancel;
    if (!pending || now() - pending.at > CANCEL_PENDING_TTL_MS) return null;
    return pending;
  }

  async function clearPendingCancel({ shop, clientId }) {
    const key = sessionKey(shop, clientId);
    const session = await kv.get(key);
    if (session?.pendingCancel) await kv.set(key, { ...session, pendingCancel: null });
  }

  /** Remember which order is being discussed so the shopper never has to repeat the number. */
  async function setLastOrder({ shop, clientId, orderNumber }) {
    const key = sessionKey(shop, clientId);
    const session = (await kv.get(key)) || {};
    await kv.set(key, { ...session, lastOrderNumber: String(orderNumber || "") });
  }

  /**
   * Verified email + last order number in ONE read (the per-turn hot path). The sliding-window
   * refresh of the verification is written without making the customer's turn wait for it.
   */
  async function getChatState({ shop, clientId }) {
    const key = sessionKey(shop, clientId);
    const session = await kv.get(key);
    const verified = Boolean(session?.verifiedEmail && session.verifiedUntil > now());
    if (verified) {
      Promise.resolve(kv.set(key, { ...session, verifiedUntil: now() + VERIFIED_TTL_MS })).catch(() => {});
    }
    return { verifiedEmail: verified ? session.verifiedEmail : "", lastOrderNumber: session?.lastOrderNumber || "" };
  }

  async function getLastOrder({ shop, clientId }) {
    const session = await kv.get(sessionKey(shop, clientId));
    return session?.lastOrderNumber || "";
  }

  async function pendingEmail({ shop, clientId }) {
    const session = await kv.get(sessionKey(shop, clientId));
    return session?.email || null;
  }

  async function clear({ shop, clientId }) {
    await kv.delete(sessionKey(shop, clientId));
  }

  return {
    requestOtp, verifyOtp, getVerifiedEmail, getChatState, clearVerification, setLastOrder, getLastOrder,
    setPendingCancel, getPendingCancel, clearPendingCancel, pendingEmail, clear,
  };
}

let defaultAuth = null;
/** Lazily-created instance backed by MongoDB (so importing this file never touches the DB). */
export function getOrderLookupAuth() {
  if (!defaultAuth) defaultAuth = createOrderLookupAuth();
  return defaultAuth;
}