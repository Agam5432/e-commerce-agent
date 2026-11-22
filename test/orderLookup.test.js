import test from "node:test";
import assert from "node:assert/strict";
import ecommerce from "../src/industries/ecommerce.js";
import {
  createOrderLookupAuth,
  createMemoryStore,
  normalizeOtpInput,
  maskEmail,
  OTP_TTL_MS,
  RESEND_COOLDOWN_MS,
  VERIFIED_TTL_MS,
} from "../src/services/orderLookupAuth.js";
import {
  parseOrderNumber,
  orderBelongsTo,
  projectOrder,
  resolveFields,
  createOrderLookupService,
  ORDER_FIELD_GROUPS,
  summarizeOrders,
} from "../src/services/shopifyOrderLookupService.js";

const SHOP = "test.myshopify.com";

// ---------------------------------------------------------------- helpers
function authHarness({ configured = true, codes = [] } = {}) {
  let clock = 1_800_000_000_000;
  const sent = [];
  const queue = [...codes];
  const store = createMemoryStore(() => clock);
  const auth = createOrderLookupAuth({
    store,
    now: () => clock,
    isEmailConfigured: () => configured,
    devLog: false,
    generateCode: () => queue.shift() ?? "123456",
    sendEmail: async (mail) => { sent.push(mail); return { ok: true }; },
  });
  return { auth, sent, store, advance: (ms) => { clock += ms; } };
}

function shopifyOrder(overrides = {}) {
  const money = (amount) => ({ shopMoney: { amount: String(amount), currencyCode: "INR" } });
  return {
    id: "gid://shopify/Order/1001",
    name: "#1001",
    createdAt: "2026-10-20T10:00:00Z",
    cancelledAt: null, cancelReason: null, closedAt: null,
    email: "buyer@example.com", phone: "+919876543210", currencyCode: "INR",
    displayFinancialStatus: "PENDING", displayFulfillmentStatus: "UNFULFILLED", returnStatus: "NO_RETURN",
    paymentGatewayNames: ["Cash on Delivery (COD)"], discountCodes: ["SAVE10"],
    customer: { id: "gid://shopify/Customer/7", email: "buyer@example.com" },
    subtotalPriceSet: money(1000), totalShippingPriceSet: money(0), totalTaxSet: money(0),
    totalDiscountsSet: money(100), totalPriceSet: money(900), totalRefundedSet: money(0),
    shippingLine: { title: "Standard", originalPriceSet: money(0) },
    shippingAddress: { name: "Test Buyer", address1: "10 Main Street", address2: null, city: "Delhi", province: "Delhi", zip: "110001", country: "India", phone: "9876543210" },
    billingAddress: { name: "Test Buyer", address1: "22 Billing Road", address2: null, city: "Delhi", province: "Delhi", zip: "110002", country: "India", phone: null },
    lineItems: { nodes: [{ title: "Linen Shirt", variantTitle: "L / Beige", quantity: 2, originalUnitPriceSet: money(500), discountedUnitPriceSet: money(450) }] },
    fulfillments: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------- OTP rules
test("valid email gets a 6-digit code by email; the code is never returned to the caller", async () => {
  const { auth, sent } = authHarness({ codes: ["482913"] });
  const res = await auth.requestOtp({ shop: SHOP, clientId: "c1", email: "Buyer@Example.com", shopName: "Demo" });
  assert.equal(res.status, "otp_sent");
  assert.equal(res.digits, 6);
  assert.equal(res.maskedEmail, "bu***@example.com");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "buyer@example.com");
  assert.equal(sent[0].code, "482913");
  assert.equal(sent[0].purpose, "order_lookup");
  assert.ok(!JSON.stringify(res).includes("482913"));
});

test("an invalid email is rejected and nothing is sent", async () => {
  const { auth, sent } = authHarness();
  for (const email of ["", "not-an-email", "a@b", "a b@c.com", "x@@y.com"]) {
    const res = await auth.requestOtp({ shop: SHOP, clientId: "c1", email });
    assert.ok(["invalid_email", "email_required"].includes(res.status), `${email} -> ${res.status}`);
  }
  assert.equal(sent.length, 0);
});

test("only an exactly 6-digit code is accepted; 4, 5 or 7 digits are invalid and do not burn the OTP", async () => {
  const { auth } = authHarness({ codes: ["482913"] });
  await auth.requestOtp({ shop: SHOP, clientId: "c1", email: "buyer@example.com" });
  for (const bad of ["4829", "48291", "4829130"]) {
    const res = await auth.verifyOtp({ shop: SHOP, clientId: "c1", code: bad });
    assert.equal(res.status, "invalid_format", bad);
  }
  // The real code still works because short/long attempts are not "wrong code" attempts.
  assert.equal((await auth.verifyOtp({ shop: SHOP, clientId: "c1", code: "482913" })).status, "verified");
});

test("a wrong 6-digit code cancels that OTP for good; resend gives a new working code", async () => {
  const { auth, advance } = authHarness({ codes: ["111111", "222222"] });
  await auth.requestOtp({ shop: SHOP, clientId: "c1", email: "buyer@example.com" });

  assert.equal((await auth.verifyOtp({ shop: SHOP, clientId: "c1", code: "999999" })).status, "wrong_otp");
  // Even the CORRECT old code can no longer be used.
  assert.equal((await auth.verifyOtp({ shop: SHOP, clientId: "c1", code: "111111" })).status, "otp_invalidated");
  assert.equal(await auth.getVerifiedEmail({ shop: SHOP, clientId: "c1" }), null);

  // Resend (no email needed): allowed immediately because the old OTP is dead.
  advance(1000);
  const resend = await auth.requestOtp({ shop: SHOP, clientId: "c1" });
  assert.equal(resend.status, "otp_sent");
  assert.equal((await auth.verifyOtp({ shop: SHOP, clientId: "c1", code: "111111" })).status, "wrong_otp");
});

test("resend then correct new code verifies; verified email is remembered for the session", async () => {
  const { auth, advance } = authHarness({ codes: ["111111", "222222"] });
  await auth.requestOtp({ shop: SHOP, clientId: "c1", email: "buyer@example.com" });
  await auth.verifyOtp({ shop: SHOP, clientId: "c1", code: "000000" });
  advance(1000);
  await auth.requestOtp({ shop: SHOP, clientId: "c1" });
  const ok = await auth.verifyOtp({ shop: SHOP, clientId: "c1", code: "222222" });
  assert.equal(ok.status, "verified");
  assert.equal(await auth.getVerifiedEmail({ shop: SHOP, clientId: "c1" }), "buyer@example.com");
  // One-time use: the same code cannot be replayed.
  assert.equal((await auth.verifyOtp({ shop: SHOP, clientId: "c1", code: "222222" })).status, "no_otp_pending");
});

test("a code expires after 10 minutes and verification lasts 30 days", async () => {
  const { auth, advance } = authHarness({ codes: ["333333", "444444"] });
  await auth.requestOtp({ shop: SHOP, clientId: "c1", email: "buyer@example.com" });
  advance(OTP_TTL_MS + 1000);
  assert.equal((await auth.verifyOtp({ shop: SHOP, clientId: "c1", code: "333333" })).status, "expired");

  await auth.requestOtp({ shop: SHOP, clientId: "c1" });
  assert.equal((await auth.verifyOtp({ shop: SHOP, clientId: "c1", code: "444444" })).status, "verified");
  advance(4 * 60 * 60 * 1000 + 1000); // the old 4-hour rule is gone
  assert.equal(await auth.getVerifiedEmail({ shop: SHOP, clientId: "c1" }), "buyer@example.com");
  advance(VERIFIED_TTL_MS + 1000); // idle past the verified window: verify again
  assert.equal(await auth.getVerifiedEmail({ shop: SHOP, clientId: "c1" }), null);
});

test("clearing the chat removes the verification", async () => {
  const { auth } = authHarness({ codes: ["666666"] });
  await auth.requestOtp({ shop: SHOP, clientId: "c1", email: "buyer@example.com" });
  await auth.verifyOtp({ shop: SHOP, clientId: "c1", code: "666666" });
  await auth.clearVerification({ shop: SHOP, clientId: "c1" });
  assert.equal(await auth.getVerifiedEmail({ shop: SHOP, clientId: "c1" }), null);
});

test("verification does not carry over to another browser (clientId)", async () => {
  const { auth } = authHarness({ codes: ["555555"] });
  await auth.requestOtp({ shop: SHOP, clientId: "c1", email: "buyer@example.com" });
  await auth.verifyOtp({ shop: SHOP, clientId: "c1", code: "555555" });
  assert.equal(await auth.getVerifiedEmail({ shop: SHOP, clientId: "someone-else" }), null);
  assert.equal((await auth.verifyOtp({ shop: SHOP, clientId: "someone-else", code: "555555" })).status, "no_otp_pending");
});

test("resend spam is throttled (cooldown + hourly limit per email)", async () => {
  const { auth, sent, advance } = authHarness();
  assert.equal((await auth.requestOtp({ shop: SHOP, clientId: "c1", email: "buyer@example.com" })).status, "otp_sent");
  const quick = await auth.requestOtp({ shop: SHOP, clientId: "c1" });
  assert.equal(quick.status, "cooldown");
  for (let i = 0; i < 4; i++) {
    advance(RESEND_COOLDOWN_MS + 1000);
    assert.equal((await auth.requestOtp({ shop: SHOP, clientId: "c1" })).status, "otp_sent");
  }
  advance(RESEND_COOLDOWN_MS + 1000);
  assert.equal((await auth.requestOtp({ shop: SHOP, clientId: "c1" })).status, "rate_limited");
  assert.equal(sent.length, 5);
});

test("without a configured mailbox (production) no code is pretended to be sent", async () => {
  const { auth, sent } = authHarness({ configured: false });
  const res = await auth.requestOtp({ shop: SHOP, clientId: "c1", email: "buyer@example.com" });
  assert.equal(res.status, "email_unavailable");
  assert.equal(sent.length, 0);
});

test("spoken / formatted codes are normalised to digits", () => {
  assert.equal(normalizeOtpInput("482 913"), "482913");
  assert.equal(normalizeOtpInput("4-8-2-9-1-3"), "482913");
  assert.equal(normalizeOtpInput("४८२९१३"), "482913");
  assert.equal(normalizeOtpInput("four eight two nine one three"), "482913");
  assert.equal(normalizeOtpInput("char aath do nau ek teen"), "482913");
  assert.equal(normalizeOtpInput("hello"), "");
  assert.equal(maskEmail("buyer@example.com"), "bu***@example.com");
});

// ---------------------------------------------------------------- lookup service
test("order numbers are parsed from natural input", () => {
  assert.equal(parseOrderNumber("#1001"), "1001");
  assert.equal(parseOrderNumber("order number 1001"), "1001");
  assert.equal(parseOrderNumber(" # 1001 "), "1001");
  assert.equal(parseOrderNumber("one zero zero one"), "1001");
  assert.equal(parseOrderNumber("१००१"), "1001");
  assert.equal(parseOrderNumber(""), "");
  assert.equal(parseOrderNumber("1001; drop"), "");
});

test("findOrder matches the exact order name only", async () => {
  const seen = [];
  const service = createOrderLookupService({
    graphql: async (shop, query, variables) => {
      seen.push(variables.query);
      return { orders: { nodes: [shopifyOrder({ name: "#11001" }), shopifyOrder({ name: "#1001" })] } };
    },
  });
  assert.equal((await service.findOrder(SHOP, "1001")).name, "#1001");
  assert.equal(seen[0], "name:#1001");
  const none = createOrderLookupService({ graphql: async () => ({ orders: { nodes: [shopifyOrder({ name: "#11001" })] } }) });
  assert.equal(await none.findOrder(SHOP, "1001"), null);
});

test("ownership: customer id or verified email only (case-insensitive), never anyone else's", () => {
  const order = shopifyOrder();
  assert.equal(orderBelongsTo(order, { customerGid: "gid://shopify/Customer/7" }), true);
  assert.equal(orderBelongsTo(order, { customerGid: "gid://shopify/Customer/8" }), false);
  assert.equal(orderBelongsTo(order, { verifiedEmail: "BUYER@example.com" }), true);
  assert.equal(orderBelongsTo(order, { verifiedEmail: "other@example.com" }), false);
  assert.equal(orderBelongsTo(order, {}), false);
  assert.equal(orderBelongsTo(shopifyOrder({ email: null, customer: null }), { verifiedEmail: "buyer@example.com" }), false);
});

test("only the requested detail groups are exposed", () => {
  const order = shopifyOrder();
  const status = projectOrder(order, ["status"]);
  assert.deepEqual(status.shown, ["status"]);
  assert.equal(status.details.fulfillmentStatus, "unfulfilled");
  assert.equal(status.details.shipmentStatus, "not shipped yet");
  const text = JSON.stringify(status.details);
  for (const secret of ["10 Main Street", "22 Billing Road", "Linen Shirt", "9876543210", "SAVE10", "buyer@example.com"]) {
    assert.ok(!text.includes(secret), `status leaked ${secret}`);
  }

  const address = projectOrder(order, ["shipping_address"]);
  assert.ok(JSON.stringify(address.details).includes("10 Main Street"));
  assert.ok(!JSON.stringify(address.details).includes("22 Billing Road"));
  assert.ok(!JSON.stringify(address.details).includes("Linen Shirt"));

  const all = projectOrder(order, ["all"]);
  assert.deepEqual(all.shown, ORDER_FIELD_GROUPS);
  const everything = JSON.stringify(all.details);
  for (const part of ["10 Main Street", "22 Billing Road", "Linen Shirt", "SAVE10", "₹900"]) assert.ok(everything.includes(part), part);
});

test("unknown or missing fields default to status; aliases map to real groups", () => {
  assert.deepEqual(resolveFields(undefined), ["status"]);
  assert.deepEqual(resolveFields(["banana"]), ["status"]);
  assert.deepEqual(resolveFields(["delivery", "address"]), ["tracking", "shipping_address"]);
});

test("shipment / tracking details come straight from Shopify fulfillments", () => {
  const order = shopifyOrder({
    displayFulfillmentStatus: "FULFILLED",
    fulfillments: [{
      status: "SUCCESS", displayStatus: "IN_TRANSIT", createdAt: "2026-10-21T08:00:00Z",
      estimatedDeliveryAt: "2026-10-25T00:00:00Z", inTransitAt: "2026-10-22T08:00:00Z", deliveredAt: null,
      trackingInfo: [{ company: "Delhivery", number: "DL123", url: "https://track.example/DL123" }],
    }],
  });
  const { details } = projectOrder(order, ["tracking"]);
  assert.equal(details.shipments[0].shipmentStatus, "in transit");
  assert.equal(details.shipments[0].tracking[0].trackingNumber, "DL123");
  assert.equal(details.shipments[0].estimatedDelivery, "25 Oct 2026");
  assert.equal(projectOrder(order, ["status"]).details.shipmentStatus[0], "in transit");
});

// ---------------------------------------------------------------- agent tool handlers
function sessionFor({ verifiedCustomerId = null, orders = [shopifyOrder()], codes = ["482913"], lang = "en", cancelResult = null } = {}) {
  const h = authHarness({ codes });
  const lookupCalls = [];
  const cancelCalls = [];
  const orderLookup = {
    async findOrder(shop, number) {
      lookupCalls.push(number);
      return orders.find((o) => parseOrderNumber(o.name) === parseOrderNumber(number)) || null;
    },
    async listOrders(shop, identity) {
      lookupCalls.push({ list: identity });
      return { timezone: "Asia/Kolkata", hasMore: false, orders: orders.filter((o) => orderBelongsTo(o, identity)) };
    },
    async cancelOrder(shop, order, options) {
      cancelCalls.push({ name: order.name, ...options });
      if (cancelResult) return cancelResult;
      order.cancelledAt = "2026-10-29T10:00:00Z";
      return { status: "cancelled", order };
    },
  };
  // `message` = what the customer just typed (the cancel flow needs a NEW message for each step).
  const make = (message = "x", history = []) => ecommerce.createSession(
    SHOP,
    { clientId: "browser-1", userMessage: message, history, replyLanguage: lang, verifiedCustomerId, customerLoggedIn: Boolean(verifiedCustomerId) },
    { orderAuth: h.auth, orderLookup, loadCheckout: async () => null, saveCheckout: async () => null },
  );
  return { make, lookupCalls, cancelCalls, ...h };
}

test("tools are registered for the model", () => {
  const names = ecommerce.toolDefinitions.map((t) => t.function.name);
  for (const name of ["send_order_otp", "verify_order_otp", "get_order_details", "show_preview"]) assert.ok(names.includes(name), name);
});

test("guest cannot read any order before verifying", async () => {
  const s = sessionFor();
  const res = await s.make().handlers.get_order_details({ orderNumber: "1001", fields: ["all"] });
  assert.equal(res.status, "verification_required");
  assert.equal(s.lookupCalls.length, 0);
  assert.ok(!JSON.stringify(res).includes("Main Street"));
});

test("guest flow: email -> OTP -> wrong code -> resend -> verify -> only the asked detail", async () => {
  const s = sessionFor({ codes: ["482913", "654321"] });
  const run = async (tool, args) => s.make().handlers[tool](args);

  assert.equal((await run("send_order_otp", { email: "nope" })).status, "invalid_email");
  const sentRes = await run("send_order_otp", { email: "buyer@example.com" });
  assert.equal(sentRes.status, "otp_sent");

  assert.equal((await run("verify_order_otp", { code: "4829" })).status, "invalid_format");
  assert.equal((await run("verify_order_otp", { code: "000000" })).status, "wrong_otp");
  assert.equal((await run("verify_order_otp", { code: "482913" })).status, "otp_invalidated");

  s.advance(1000);
  assert.equal((await run("send_order_otp", {})).status, "otp_sent");
  const verified = await run("verify_order_otp", { code: "654321" });
  assert.equal(verified.status, "verified");

  const res = await run("get_order_details", { orderNumber: "#1001", fields: ["status"] });
  assert.equal(res.status, "ok");
  assert.deepEqual(res.shown, ["status"]);
  assert.equal(res.details.paymentStatus, "pending");
  assert.ok(!JSON.stringify(res).includes("Main Street"));
  assert.ok(!JSON.stringify(res).includes("Linen Shirt"));

  // Follow-up for one different detail, still without a new OTP.
  const addr = await run("get_order_details", { orderNumber: "1001", fields: ["shipping_address"] });
  assert.ok(JSON.stringify(addr.details).includes("10 Main Street"));
  assert.ok(!JSON.stringify(addr.details).includes("Linen Shirt"));
});

test("no tool result ever contains the verification code", async () => {
  const s = sessionFor({ codes: ["482913"] });
  const results = [
    await s.make().handlers.send_order_otp({ email: "buyer@example.com" }),
    await s.make().handlers.verify_order_otp({ code: "999999" }),
  ];
  for (const r of results) assert.ok(!JSON.stringify(r).includes("482913"));
});

test("a verified email cannot read someone else's order, and the answer reveals nothing", async () => {
  const others = shopifyOrder({ name: "#2002", email: "victim@example.com", customer: { id: "gid://shopify/Customer/99", email: "victim@example.com" } });
  const s = sessionFor({ orders: [shopifyOrder(), others], codes: ["482913"] });
  await s.make().handlers.send_order_otp({ email: "buyer@example.com" });
  await s.make().handlers.verify_order_otp({ code: "482913" });

  const res = await s.make().handlers.get_order_details({ orderNumber: "2002", fields: ["all"] });
  assert.equal(res.status, "not_found");
  const text = JSON.stringify(res);
  assert.ok(!text.includes("victim@example.com"));
  assert.ok(!text.includes("Main Street"));
  assert.equal((await s.make().handlers.get_order_details({ orderNumber: "9999", fields: ["all"] })).status, "not_found");
});

test("logged-in customer needs no OTP and only sees their own orders", async () => {
  const others = shopifyOrder({ name: "#2002", email: "victim@example.com", customer: { id: "gid://shopify/Customer/99", email: "victim@example.com" } });
  const s = sessionFor({ verifiedCustomerId: "gid://shopify/Customer/7", orders: [shopifyOrder(), others] });

  const skip = await s.make().handlers.send_order_otp({});
  assert.equal(skip.status, "already_logged_in");

  const mine = await s.make().handlers.get_order_details({ orderNumber: "1001", fields: ["items"] });
  assert.equal(mine.status, "ok");
  assert.equal(mine.details.items[0].title, "Linen Shirt");
  assert.equal(mine.details.items[0].quantity, 2);
  assert.ok(!JSON.stringify(mine).includes("Main Street"));

  const theirs = await s.make().handlers.get_order_details({ orderNumber: "2002", fields: ["all"] });
  assert.equal(theirs.status, "not_found");
  assert.equal(theirs.canVerifyOtherEmail, true);
});

test("a Shopify outage is reported honestly without inventing data", async () => {
  const s = sessionFor({ verifiedCustomerId: "gid://shopify/Customer/7" });
  const session = ecommerce.createSession(SHOP, { clientId: "b", userMessage: "x", history: [], replyLanguage: "en", verifiedCustomerId: "gid://shopify/Customer/7" }, {
    orderAuth: s.auth, orderLookup: { findOrder: async () => { throw new Error("boom"); } },
    loadCheckout: async () => null, saveCheckout: async () => null,
  });
  const res = await session.handlers.get_order_details({ orderNumber: "1001" });
  assert.equal(res.status, "unavailable");
});

test("the order flow is described in the system prompt for guests and logged-in customers", () => {
  const guest = ecommerce.buildSystemPrompt(SHOP, { replyLanguage: "en", history: [], userMessage: "" });
  assert.match(guest, /ORDER STATUS, TRACKING & ORDER DETAILS/);
  assert.match(guest, /GUEST \(not logged in\)/);
  const logged = ecommerce.buildSystemPrompt(SHOP, { replyLanguage: "en", history: [], userMessage: "", customerLoggedIn: true, verifiedCustomerId: "gid://shopify/Customer/7", customer: { id: "gid://shopify/Customer/7", name: "Asha" } });
  assert.match(logged, /Customer login right now: LOGGED IN/);
});

// ---------------------------------------------------------------- stay verified (no repeated OTP)
test("once verified, the shopper is not asked again while the chat lives (no 4-hour rule)", async () => {
  const s = sessionFor({ codes: ["482913"] });
  await s.make().handlers.send_order_otp({ email: "buyer@example.com" });
  await s.make().handlers.verify_order_otp({ code: "482913" });

  s.advance(5 * 60 * 60 * 1000); // well past 4 hours
  assert.equal((await s.make().handlers.get_order_details({ orderNumber: "1001" })).status, "ok");
  assert.equal((await s.make().handlers.send_order_otp({})).status, "already_verified");
  assert.equal(s.sent.length, 1);
});

test("an idle verification expires after 30 days and then verification is required again", async () => {
  const s = sessionFor({ codes: ["482913"] });
  await s.make().handlers.send_order_otp({ email: "buyer@example.com" });
  await s.make().handlers.verify_order_otp({ code: "482913" });
  s.advance(VERIFIED_TTL_MS + 1000);
  assert.equal((await s.make().handlers.get_order_details({ orderNumber: "1001" })).status, "verification_required");
});

test("the prompt tells the model the shopper is already verified so it never re-asks", () => {
  const verified = ecommerce.buildSystemPrompt(SHOP, { replyLanguage: "en", history: [], userMessage: "", orderVerifiedEmail: "bu***@example.com" });
  assert.match(verified, /ALREADY VERIFIED: this customer already verified bu\*\*\*@example\.com/);
  const fresh = ecommerce.buildSystemPrompt(SHOP, { replyLanguage: "en", history: [], userMessage: "" });
  assert.doesNotMatch(fresh, /ALREADY VERIFIED/);
});

// ---------------------------------------------------------------- real chat regression (order 1002 shipped mid-chat)
test("status is always fetched fresh and the current order is remembered (no repeated order number)", async () => {
  const order = shopifyOrder({ name: "#1002", fulfillments: [], displayFulfillmentStatus: "UNFULFILLED" });
  const s = sessionFor({ orders: [order], codes: ["482913"] });
  await s.make().handlers.send_order_otp({ email: "buyer@example.com" });
  await s.make().handlers.verify_order_otp({ code: "482913" });

  const before = await s.make().handlers.get_order_details({ orderNumber: "1002", fields: ["tracking"] });
  assert.equal(before.status, "ok");
  assert.deepEqual(before.details.shipments, []);

  // The store ships the order in Shopify while the chat is still open.
  order.displayFulfillmentStatus = "FULFILLED";
  order.fulfillments = [{
    status: "SUCCESS", displayStatus: "CONFIRMED", createdAt: "2026-10-29T08:00:00Z",
    estimatedDeliveryAt: null, inTransitAt: null, deliveredAt: null,
    trackingInfo: [{ company: "FedEx", number: "1234567890", url: null }],
  }];

  // Customer says "shipment / delivery" with NO order number: the remembered order is re-fetched, fresh.
  const after = await s.make().handlers.get_order_details({ fields: ["tracking"] });
  assert.equal(after.status, "ok");
  assert.equal(after.orderName, "#1002");
  assert.equal(after.details.shipments[0].tracking[0].carrier, "FedEx");
  assert.equal(after.details.shipments[0].tracking[0].trackingNumber, "1234567890");
  assert.equal(s.lookupCalls.length, 2, "every question hits Shopify again");
});

test("an order that was not found is never remembered; with nothing remembered the order number is requested", async () => {
  const s = sessionFor({ verifiedCustomerId: "gid://shopify/Customer/7" });
  assert.equal((await s.make().handlers.get_order_details({ orderNumber: "5555" })).status, "not_found");
  assert.equal((await s.make().handlers.get_order_details({})).status, "need_order_number");
});

test("the prompt names the order already in discussion and demands fresh lookups", () => {
  const p = ecommerce.buildSystemPrompt(SHOP, { replyLanguage: "en", history: [], userMessage: "", lastOrderNumber: "1002" });
  assert.match(p, /ORDER ALREADY IN DISCUSSION: 1002/);
  assert.match(p, /ALWAYS FRESH/);
  assert.doesNotMatch(ecommerce.buildSystemPrompt(SHOP, { replyLanguage: "en", history: [], userMessage: "" }), /ORDER ALREADY IN DISCUSSION/);
});

// ---------------------------------------------------------------- order cancellation
import { cancellability, isPaidOrder } from "../src/services/shopifyOrderLookupService.js";

async function verifiedGuest(opts = {}) {
  const s = sessionFor({ codes: ["482913"], ...opts });
  await s.make().handlers.send_order_otp({ email: "buyer@example.com" });
  await s.make().handlers.verify_order_otp({ code: "482913" });
  return s;
}

test("cancel flow: details + 'are you sure' -> yes -> reason -> cancelled (each step in a new message)", async () => {
  const order = shopifyOrder({ name: "#1002" });
  const s = await verifiedGuest({ orders: [order] });

  const ask = await s.make("cancel my order 1002").handlers.request_order_cancellation({ orderNumber: "1002" });
  assert.equal(ask.status, "confirmation_needed");
  assert.equal(ask.orderName, "#1002");
  assert.equal(ask.details.items[0].title, "Linen Shirt");
  assert.equal(ask.details.total.display, "₹900");
  assert.equal(ask.refundWillBeIssued, false);
  assert.equal(s.cancelCalls.length, 0, "nothing is cancelled yet");

  // The model must not chain the next step inside the same customer message.
  assert.equal((await s.make("cancel my order 1002").handlers.confirm_order_cancellation({ confirmed: true })).status, "wait_for_customer");

  const yes = await s.make("yes").handlers.confirm_order_cancellation({ confirmed: true });
  assert.equal(yes.status, "reason_needed");
  assert.equal(s.cancelCalls.length, 0);

  assert.equal((await s.make("yes").handlers.cancel_order({ reason: "ordered by mistake" })).status, "wait_for_customer");
  assert.equal((await s.make("haan").handlers.cancel_order({ reason: "yes" })).status, "reason_needed");
  assert.equal(s.cancelCalls.length, 0);

  const done = await s.make("ordered it by mistake").handlers.cancel_order({ reason: "ordered it by mistake" });
  assert.equal(done.status, "cancelled");
  assert.equal(s.cancelCalls.length, 1);
  assert.equal(s.cancelCalls[0].name, "#1002");
  assert.equal(s.cancelCalls[0].reason, "ordered it by mistake");
  assert.equal(s.cancelCalls[0].refund, false); // COD / payment pending: nothing to refund

  // Cannot be cancelled twice.
  assert.equal((await s.make("cancel again").handlers.request_order_cancellation({ orderNumber: "1002" })).reason, "already_cancelled");
});

test("steps cannot be skipped: no cancel without request, confirmation and reason", async () => {
  const s = await verifiedGuest();
  assert.equal((await s.make("a").handlers.cancel_order({ reason: "because" })).status, "no_cancellation_pending");
  assert.equal((await s.make("b").handlers.confirm_order_cancellation({ confirmed: true })).status, "no_cancellation_pending");

  await s.make("cancel 1001").handlers.request_order_cancellation({ orderNumber: "1001" });
  // reason supplied but the customer never said yes
  assert.equal((await s.make("c").handlers.cancel_order({ reason: "changed my mind" })).status, "confirmation_missing");
  assert.equal(s.cancelCalls.length, 0);
});

test("saying no keeps the order and clears the request", async () => {
  const s = await verifiedGuest();
  await s.make("cancel 1001").handlers.request_order_cancellation({ orderNumber: "1001" });
  const no = await s.make("no leave it").handlers.confirm_order_cancellation({ confirmed: false });
  assert.equal(no.status, "cancellation_declined");
  assert.equal((await s.make("later").handlers.cancel_order({ reason: "changed my mind" })).status, "no_cancellation_pending");
  assert.equal(s.cancelCalls.length, 0);
});

// MOCK/AUTOMATED: scripted Shopify. The flow rules: confirmation once, reason once, nothing the customer already said is asked again.
test("cancel flow: a reason given with the request is reused, never asked again", async () => {
  const s = await verifiedGuest({ orders: [shopifyOrder({ name: "#1002" })] });
  const msg = "I want to cancel order 1002, I ordered the wrong product";
  const ask = await s.make(msg).handlers.request_order_cancellation({ orderNumber: "1002", reason: "I ordered the wrong product" });
  assert.equal(ask.status, "confirmation_needed");
  // the model calls the request again on a later turn: the flow is NOT restarted
  const again = await s.make("hmm").handlers.request_order_cancellation({ orderNumber: "1002" });
  assert.equal(again.status, "confirmation_pending");
  const yes = await s.make("yes").handlers.confirm_order_cancellation({ confirmed: true });
  assert.equal(yes.status, "reason_known");
  assert.match(yes.instruction_for_ai, /Do NOT ask/);
  const done = await s.make("yes").handlers.cancel_order({ reason: "something the model made up" });
  assert.equal(done.status, "cancelled");
  assert.equal(s.cancelCalls.length, 1);
  assert.equal(s.cancelCalls[0].reason, "I ordered the wrong product", "the customer's own words, not the model's");
});

test("cancel flow: 'yes' and the reason in one message cancel at once (no second question)", async () => {
  const s = await verifiedGuest({ orders: [shopifyOrder({ name: "#1002" })] });
  await s.make("cancel my order").handlers.request_order_cancellation({ orderNumber: "1002" });
  const text = "haan cancel kar do, galat product order kiya tha";
  const yes = await s.make(text).handlers.confirm_order_cancellation({ confirmed: true, reason: "galat product order kiya tha" });
  assert.equal(yes.status, "reason_known");
  const done = await s.make(text).handlers.cancel_order({ reason: "ordered wrong product" }); // model translated: the original is kept
  assert.equal(done.status, "cancelled");
  assert.equal(s.cancelCalls[0].reason, "galat product order kiya tha");
});

test("cancel flow: reason asked once; a repeated request or repeated 'yes' does not ask the confirmation again", async () => {
  const s = await verifiedGuest({ orders: [shopifyOrder({ name: "#1002" })] });
  await s.make("cancel 1002").handlers.request_order_cancellation({ orderNumber: "1002" });
  assert.equal((await s.make("yes").handlers.confirm_order_cancellation({ confirmed: true })).status, "reason_needed");
  // the model wrongly calls the request / confirm again: it is told the customer already confirmed
  const re = await s.make("ok").handlers.request_order_cancellation({ orderNumber: "1002" });
  assert.equal(re.status, "reason_needed");
  assert.match(re.instruction_for_ai, /Do not ask for confirmation again/);
  assert.equal((await s.make("ok").handlers.confirm_order_cancellation({ confirmed: true })).status, "reason_needed");
  assert.equal(s.cancelCalls.length, 0);
  assert.equal((await s.make("it arrived late for the event").handlers.cancel_order({ reason: "arrived late" })).status, "cancelled");
  assert.equal(s.cancelCalls[0].reason, "arrived late", "a fragment of what the customer wrote is kept as given");
});

test("cancel flow: changing their mind after confirming (or saying no) stops it; a new request starts fresh", async () => {
  const s = await verifiedGuest({ orders: [shopifyOrder({ name: "#1002" })] });
  await s.make("cancel 1002").handlers.request_order_cancellation({ orderNumber: "1002" });
  await s.make("yes").handlers.confirm_order_cancellation({ confirmed: true });
  // they change their mind instead of giving a reason: the model has no cancel to run, and a bare "no" is not a reason
  assert.equal((await s.make("no").handlers.cancel_order({ reason: "no" })).status, "reason_needed");
  assert.equal(s.cancelCalls.length, 0);
  assert.equal((await s.make("no wait, keep it").handlers.confirm_order_cancellation({ confirmed: false })).status, "cancellation_declined");
  assert.equal((await s.make("sorry").handlers.cancel_order({ reason: "sorry" })).status, "no_cancellation_pending");
  assert.equal((await s.make("ok cancel it").handlers.request_order_cancellation({ orderNumber: "1002" })).status, "confirmation_needed");
});

// A real-store run: after "Yes, I am sure" the model asked for the reason WITHOUT calling confirm_order_cancellation, so the
// backend still waited for a "yes" and the reason message got "please confirm again". A yes already given after the question counts.
test("cancel flow: a yes the model never reported is still honoured when the reason arrives (no second confirmation)", async () => {
  const s = await verifiedGuest({ orders: [shopifyOrder({ name: "#1002" })] });
  await s.make("Yes, I want to cancel order 1002").handlers.request_order_cancellation({ orderNumber: "1002" });
  const history = [
    { role: "user", content: "Yes, I want to cancel order 1002" },
    { role: "assistant", content: "Are you sure you want to cancel order #1002? Please reply yes or no." },
    { role: "user", content: "Yes, I am sure" },
    { role: "assistant", content: "Could you please tell me the reason for cancelling this order?" },
  ];
  const reason = "galat product order kiya tha, size bhi sahi nahi";
  const done = await s.make(reason, history).handlers.cancel_order({ reason });
  assert.equal(done.status, "cancelled");
  assert.equal(s.cancelCalls[0].reason, reason);
});

test("cancel flow: that earlier-yes rule never lets the REQUEST message itself count as the confirmation", async () => {
  const s = await verifiedGuest({ orders: [shopifyOrder({ name: "#1002" })] });
  await s.make("Yes, I want to cancel order 1002").handlers.request_order_cancellation({ orderNumber: "1002" });
  const history = [{ role: "user", content: "Yes, I want to cancel order 1002" }, { role: "assistant", content: "Are you sure you want to cancel order #1002?" }];
  const res = await s.make("wrong size ordered", history).handlers.cancel_order({ reason: "wrong size ordered" });
  assert.equal(res.status, "confirmation_missing");
  assert.equal(s.cancelCalls.length, 0);
});

test("cancel flow: a no after the question means nothing is cancelled even if a reason follows", async () => {
  const s = await verifiedGuest({ orders: [shopifyOrder({ name: "#1002" })] });
  await s.make("cancel order 1002").handlers.request_order_cancellation({ orderNumber: "1002" });
  const history = [{ role: "user", content: "cancel order 1002" }, { role: "assistant", content: "Are you sure you want to cancel order #1002?" }, { role: "user", content: "No, keep it" }, { role: "assistant", content: "Okay." }];
  const res = await s.make("it was the wrong size anyway", history).handlers.cancel_order({ reason: "it was the wrong size anyway" });
  assert.equal(res.status, "confirmation_missing");
  assert.equal(s.cancelCalls.length, 0);
});

test("shipped / fulfilled orders cannot be cancelled (return, exchange or refund instead)", async () => {
  const shipped = shopifyOrder({
    name: "#1002", displayFulfillmentStatus: "FULFILLED",
    fulfillments: [{ status: "SUCCESS", displayStatus: "CONFIRMED", createdAt: "2026-10-29T08:00:00Z", trackingInfo: [] }],
  });
  const s = await verifiedGuest({ orders: [shipped] });
  const res = await s.make("cancel 1002").handlers.request_order_cancellation({ orderNumber: "1002" });
  assert.equal(res.status, "not_cancellable");
  assert.equal(res.reason, "already_shipped");
  assert.match(res.instruction_for_ai, /return, exchange or refund/);
  assert.equal(s.cancelCalls.length, 0);
  for (const status of ["PARTIALLY_FULFILLED", "IN_PROGRESS"]) {
    assert.equal(cancellability(shopifyOrder({ displayFulfillmentStatus: status })).ok, false, status);
  }
  assert.equal(cancellability(shopifyOrder()).ok, true);
});

test("if the order ships between 'yes' and the reason, the cancel is refused", async () => {
  const order = shopifyOrder({ name: "#1002" });
  const s = await verifiedGuest({ orders: [order] });
  await s.make("cancel").handlers.request_order_cancellation({ orderNumber: "1002" });
  await s.make("yes").handlers.confirm_order_cancellation({ confirmed: true });
  order.displayFulfillmentStatus = "FULFILLED"; // store ships it meanwhile
  order.fulfillments = [{ status: "SUCCESS", displayStatus: "CONFIRMED", createdAt: "2026-10-29T08:00:00Z", trackingInfo: [] }];
  const res = await s.make("wrong size").handlers.cancel_order({ reason: "wrong size" });
  assert.equal(res.status, "not_cancellable");
  assert.equal(s.cancelCalls.length, 0);
});

test("a verified guest can cancel even hours later (no 4-hour rule); clearing the chat requires verifying again", async () => {
  const s = await verifiedGuest();
  s.advance(5 * 60 * 60 * 1000); // 5h after verifying: still allowed
  assert.equal((await s.make("cancel").handlers.request_order_cancellation({ orderNumber: "1001" })).status, "confirmation_needed");
  await s.make("yes").handlers.confirm_order_cancellation({ confirmed: true });
  const res = await s.make("changed my mind").handlers.cancel_order({ reason: "changed my mind" });
  assert.equal(res.status, "cancelled");
  assert.equal(s.cancelCalls.length, 1);
});

test("a half-finished cancellation request lapses after 15 minutes", async () => {
  const s = await verifiedGuest();
  await s.make("cancel").handlers.request_order_cancellation({ orderNumber: "1001" });
  s.advance(16 * 60 * 1000);
  assert.equal((await s.make("yes").handlers.confirm_order_cancellation({ confirmed: true })).status, "no_cancellation_pending");
});

test("logged-in customers can cancel any time, but only their own orders; paid orders are refunded", async () => {
  const mine = shopifyOrder({ displayFinancialStatus: "PAID" });
  const theirs = shopifyOrder({ name: "#2002", email: "victim@example.com", customer: { id: "gid://shopify/Customer/99", email: "victim@example.com" } });
  const s = sessionFor({ verifiedCustomerId: "gid://shopify/Customer/7", orders: [mine, theirs] });
  s.advance(30 * 24 * 60 * 60 * 1000); // a month later: no expiry for logged-in customers

  const ask = await s.make("cancel 1001").handlers.request_order_cancellation({ orderNumber: "1001" });
  assert.equal(ask.status, "confirmation_needed");
  assert.equal(ask.refundWillBeIssued, true);
  await s.make("yes").handlers.confirm_order_cancellation({ confirmed: true });
  const done = await s.make("found it cheaper elsewhere").handlers.cancel_order({ reason: "found it cheaper elsewhere" });
  assert.equal(done.status, "cancelled");
  assert.equal(s.cancelCalls[0].refund, true);

  assert.equal((await s.make("cancel 2002").handlers.request_order_cancellation({ orderNumber: "2002" })).status, "not_found");
});

test("Shopify not finishing or failing the cancel is reported honestly", async () => {
  const pend = await verifiedGuest({ cancelResult: { status: "processing" } });
  await pend.make("cancel").handlers.request_order_cancellation({ orderNumber: "1001" });
  await pend.make("yes").handlers.confirm_order_cancellation({ confirmed: true });
  assert.equal((await pend.make("no need").handlers.cancel_order({ reason: "no need" })).status, "cancellation_processing");

  const bad = await verifiedGuest({ cancelResult: { status: "failed", message: "boom" } });
  await bad.make("cancel").handlers.request_order_cancellation({ orderNumber: "1001" });
  await bad.make("yes").handlers.confirm_order_cancellation({ confirmed: true });
  assert.equal((await bad.make("no need").handlers.cancel_order({ reason: "no need" })).status, "cancel_failed");
});

test("service: orderCancel mutation is sent unfulfilled-only with restock, reason note and customer notice", async () => {
  const calls = [];
  const order = shopifyOrder({ name: "#1002" });
  const service = createOrderLookupService({
    sleep: async () => {},
    graphql: async (shop, query, variables) => {
      const name = query.match(/(?:query|mutation)\s+(\w+)/)[1];
      calls.push({ name, variables });
      if (name === "OrderCancelByCustomer") return { orderCancel: { job: { id: "j1", done: false }, orderCancelUserErrors: [] } };
      return { orders: { nodes: [{ ...order, cancelledAt: "2026-10-29T10:00:00Z" }] } };
    },
  });
  const res = await service.cancelOrder(SHOP, order, { reason: "ordered by mistake", refund: false, notifyCustomer: true });
  assert.equal(res.status, "cancelled");
  const mutation = calls.find((c) => c.name === "OrderCancelByCustomer").variables;
  assert.equal(mutation.orderId, order.id);
  assert.equal(mutation.restock, true);
  assert.equal(mutation.notifyCustomer, true);
  assert.equal(mutation.refund, false);
  assert.match(mutation.staffNote, /ordered by mistake/);
});

test("service: Shopify user errors -> failed; lost response but order cancelled -> cancelled; never cancelled -> not claimed", async () => {
  const order = shopifyOrder({ name: "#1002" });
  const failing = createOrderLookupService({ sleep: async () => {}, graphql: async () => ({ orderCancel: { orderCancelUserErrors: [{ field: ["orderId"], message: "Order cannot be cancelled" }] } }) });
  const failed = await failing.cancelOrder(SHOP, order, { reason: "x" });
  assert.equal(failed.status, "failed");
  assert.match(failed.message, /cannot be cancelled/);

  const lost = createOrderLookupService({
    sleep: async () => {},
    graphql: async (shop, query) => {
      if (/mutation/.test(query)) { const e = new Error("lost"); e.uncertain = true; throw e; }
      return { orders: { nodes: [{ ...order, cancelledAt: "2026-10-29T10:00:00Z" }] } };
    },
  });
  assert.equal((await lost.cancelOrder(SHOP, order, { reason: "x" })).status, "cancelled");

  const never = createOrderLookupService({
    sleep: async () => {},
    graphql: async (shop, query) => (/mutation/.test(query) ? { orderCancel: { orderCancelUserErrors: [] } } : { orders: { nodes: [order] } }),
  });
  assert.equal((await never.cancelOrder(SHOP, order, { reason: "x" })).status, "processing");
  assert.equal(isPaidOrder(shopifyOrder({ displayFinancialStatus: "PARTIALLY_PAID" })), true);
});

test("the prompt describes the confirm -> reason -> cancel steps", () => {
  const p = ecommerce.buildSystemPrompt(SHOP, { replyLanguage: "en", history: [], userMessage: "" });
  assert.match(p, /CANCELLING AN ORDER/);
  assert.match(p, /Are you sure you want to cancel order/);
  const names = ecommerce.toolDefinitions.map((t) => t.function.name);
  for (const n of ["request_order_cancellation", "confirm_order_cancellation", "cancel_order"]) assert.ok(names.includes(n), n);
});
// ---------------------------------------------------------------- generic preview (show_preview)
test("show_preview kind=order pushes one generic preview action built from real order data", async () => {
  const s = await verifiedGuest();
  const session = s.make("order details dikhao");
  const res = await session.handlers.show_preview({ kind: "order", orderNumber: "1001" });
  assert.equal(res.status, "ok");
  assert.equal(res.previewShown, true);
  const previews = session.result().actions.filter((a) => a.type === "preview");
  assert.equal(previews.length, 1);
  assert.match(previews[0].preview.title, /1001/);
  assert.ok(previews[0].preview.items.length > 0);
  assert.ok(previews[0].preview.totals.some((t) => t.strong));
});

test("show_preview with an unknown kind asks the customer instead of guessing", async () => {
  const s = await verifiedGuest();
  const res = await s.make("preview").handlers.show_preview({ kind: "something" });
  assert.equal(res.status, "needs_clarification");
});

test("show_preview for an order needs verification for a guest", async () => {
  const s = sessionFor({ codes: ["482913"] });
  const res = await s.make("show my order").handlers.show_preview({ kind: "order", orderNumber: "1001" });
  assert.equal(res.status, "verification_required");
});
// ---------------------------------------------------------------- "how many orders did I place?"
const NOW = Date.parse("2026-10-30T12:00:00Z"); // 17:30 in India
const placed = (name, createdAt, extra = {}) => shopifyOrder({ id: `gid://shopify/Order/${name}`, name: `#${name}`, createdAt, ...extra });

test("order counts use the store's calendar day and leave cancelled orders out", () => {
  const orders = [
    placed(1006, "2026-10-30T05:30:00Z"), // today in India
    placed(1005, "2026-10-29T20:00:00Z"), // 30 Oct 01:30 in India: still today there
    placed(1004, "2026-10-29T10:00:00Z"), // yesterday
    placed(1003, "2026-10-20T10:00:00Z"),
    placed(1002, "2026-09-01T10:00:00Z"), // older than 30 days
    placed(1001, "2026-10-30T06:00:00Z", { cancelledAt: "2026-10-30T07:00:00Z" }),
  ];
  const s = summarizeOrders(orders, { timezone: "Asia/Kolkata", now: NOW });
  assert.deepEqual(s.counts, { today: 2, last7Days: 3, last30Days: 4, total: 5, cancelled: 1 });
  assert.equal(s.recentOrders[0].orderName, "#1006");
  assert.equal(s.recentOrders[0].placedOn, "2026-10-30");
  assert.equal(s.recentOrders.at(-1).status, "cancelled");
  assert.deepEqual(s.recentOrders[0].items.length > 0, true);
  assert.equal(summarizeOrders([], { timezone: "Not/AZone", now: NOW }).timezone, "UTC");
});

test("a guest must verify before hearing how many orders they placed", async () => {
  const s = sessionFor();
  const res = await s.make("maine kitne order kiye").handlers.list_my_orders();
  assert.equal(res.status, "verification_required");
  assert.equal(res.counts, undefined);
  assert.deepEqual(s.lookupCalls, []);
});

test("a logged-in customer gets only their own orders counted", async () => {
  const mine = placed(2001, "2026-10-29T10:00:00Z");
  const other = placed(2002, "2026-10-29T10:00:00Z", { email: "someone@else.com", customer: { id: "gid://shopify/Customer/99", email: "someone@else.com" } });
  const s = sessionFor({ verifiedCustomerId: "gid://shopify/Customer/7", orders: [mine, other] });
  const res = await s.make("how many orders have I placed?").handlers.list_my_orders();
  assert.equal(res.status, "ok");
  assert.equal(res.counts.total, 1);
  assert.deepEqual(res.recentOrders.map((o) => o.orderName), ["#2001"]);
  assert.match(res.coverage, /60 days/);
});

test("the list query asks Shopify for that customer's or that email's orders, and re-checks ownership", async () => {
  const calls = [];
  const service = createOrderLookupService({ graphql: async (shop, query, vars) => {
    calls.push(vars);
    return { shop: { ianaTimezone: "Asia/Kolkata" }, orders: { pageInfo: { hasNextPage: false }, nodes: [
      shopifyOrder(), shopifyOrder({ name: "#9", email: "x@y.com", customer: { id: "gid://shopify/Customer/5", email: "x@y.com" } }),
    ] } };
  } });
  const byCustomer = await service.listOrders(SHOP, { customerGid: "gid://shopify/Customer/7" });
  assert.equal(calls[0].query, "customer_id:7");
  assert.deepEqual(byCustomer.orders.map((o) => o.name), ["#1001"]);
  assert.equal(byCustomer.timezone, "Asia/Kolkata");
  await service.listOrders(SHOP, { verifiedEmail: "Buyer@Example.com" });
  assert.equal(calls[1].query, 'email:"buyer@example.com"');
  assert.deepEqual((await service.listOrders(SHOP, {})).orders, []);
  assert.equal(calls.length, 2, "no identity, no Shopify call");
});

test("the owner can switch order listing off with order lookups", () => {
  assert.ok(ecommerce.admin.configurableTools.includes("list_my_orders"));
  assert.ok(ecommerce.toolDefinitions.some((t) => t.function.name === "list_my_orders"));
});
