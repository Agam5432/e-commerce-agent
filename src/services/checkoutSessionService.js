import crypto from "node:crypto";
import CheckoutSession from "../models/CheckoutSession.js";

function normalizeShop(shop) {
  return String(shop || "").toLowerCase().trim();
}

function normalizeClient(clientId) {
  return String(clientId || "anon").slice(0, 64);
}

export async function getCheckoutSession(shop, clientId) {
  const doc = await CheckoutSession.findOne({
    shop: normalizeShop(shop),
    clientId: normalizeClient(clientId),
  }).lean();
  return doc;
}

export async function upsertCheckoutSession(shop, clientId, patch = {}) {
  const filter = {
    shop: normalizeShop(shop),
    clientId: normalizeClient(clientId),
  };

  const update = {
    $set: {
      ...patch,
    },
    $setOnInsert: {
      shop: filter.shop,
      clientId: filter.clientId,
    },
  };

  // Avoid overwriting nested objects incorrectly
  const doc = await CheckoutSession.findOneAndUpdate(filter, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  }).lean();

  return doc;
}

/**
 * Remembers what this turn was about (for a later "hello" or a return visit). Written in the
 * background and only while the database is connected, so a turn never waits for it.
 */
export function saveConversationRecap(shop, clientId, recap, { save = upsertCheckoutSession, connected = () => CheckoutSession.db?.readyState === 1 } = {}) {
  if (!connected()) return Promise.resolve(false);
  return Promise.resolve()
    .then(() => save(shop, clientId, { conversationRecap: recap }))
    .then(() => true)
    .catch(() => false);
}

/** The shopper cleared the chat: forget what was discussed too. */
// A cleared chat ends any checkout that was half done in it. Otherwise its open question stays live: a voice test cleared the chat, asked
// about the return policy, and a vague "yes, it is my same" then set billing and opened an order review for a checkout from the day
// before (2026-11-22). Saved addresses stay (the shopper can reuse them); every step and confirmation starts again.
export async function abandonCheckoutInProgress(shop, clientId) {
  const current = await getCheckoutSession(shop, clientId).catch(() => null);
  // The address typed in the cleared chat is not used silently in the next one (a voice test went straight to an order review
  // for it): it becomes the address offered for reuse, so the assistant asks before delivering there.
  const keepForReuse = current?.shipping?.address1 && !current?.lastOrderShipping?.address1 ? { lastOrderShipping: current.shipping } : {};
  await upsertCheckoutSession(shop, clientId, {
    ...keepForReuse,
    shipping: null,
    // the copy of the checkout kept beside the last cart (it would bring the address and billing straight back)
    lastCartSnapshot: null,
    step: "cart",
    shippingConfirmed: false,
    billingConfirmed: false,
    shippingNeedsUpdate: false,
    billingNeedsUpdate: false,
    billing: null,
    billingSameAsShipping: null,
    selectedPaymentMethod: null,
    paymentMethod: null,
    paymentUrl: null,
    orderQuote: null,
    checkoutAttemptId: null,
  });
}

export async function forgetConversation(shop, clientId) {
  await upsertCheckoutSession(shop, clientId, { conversationRecap: null, lastActivityAt: null });
}

export async function verifyOtp(shop, clientId, code) {
  const session = await getCheckoutSession(shop, clientId);
  if (!session?.otp?.code) {
    return { ok: false, error: "No OTP was requested. Ask them to start login again." };
  }

  const expiresAt = session.otp.expiresAt
    ? new Date(session.otp.expiresAt).getTime()
    : 0;
  if (Date.now() > expiresAt) {
    return { ok: false, error: "OTP expired. Send a new one." };
  }

  const attempts = (session.otp.attempts || 0) + 1;
  if (attempts > 5) {
    return { ok: false, error: "Too many attempts. Send a new OTP." };
  }

  const provided = String(code || "").replace(/\s+/g, "");
  if (provided !== session.otp.code) {
    await upsertCheckoutSession(shop, clientId, {
      otp: { ...session.otp, attempts },
    });
    return { ok: false, error: "Incorrect OTP. Ask them to try again or resend." };
  }

  const customer = {
    id: `otp_${crypto.randomBytes(6).toString("hex")}`,
    method: session.otp.method,
    email: session.otp.method === "email" ? session.otp.target : null,
    phone: session.otp.method === "phone" ? session.otp.target : null,
  };

  const next = await upsertCheckoutSession(shop, clientId, {
    loggedIn: true,
    loginMethod: session.otp.method === "email" ? "email_otp" : "phone_otp",
    customer,
    otp: null,
    step: "address",
  });

  return { ok: true, customer, session: next };
}

