// One order for the owner: only orders this store's chats placed, Shopify's facts shaped for the screen,
// and a slow or refusing Shopify never breaking the list.
import test from "node:test";
import assert from "node:assert/strict";
import { orderDetails, orderStatuses, presentOrder, OrderLookupError } from "../../src/admin/orderDetails.js";

const A = "a-store.myshopify.com";
const analytics = { revenue: { event: "order_placed" } };
const event = { at: new Date("2026-10-29T09:05:00Z"), conversationId: "c3", props: { orderName: "#1002", total: 500, currency: "INR", source: "agent" } };
const Events = (rows = [event]) => ({
  find: (filter) => {
    const asked = filter["props.orderName"]?.$regex;
    const hit = filter.shop === A && asked && rows.filter((r) => new RegExp(asked).test(r.props.orderName));
    const chain = { sort: () => chain, limit: () => chain, lean: async () => hit || [] };
    return chain;
  },
});
const money = (amount, currencyCode = "INR") => ({ shopMoney: { amount: String(amount), currencyCode } });
const node = {
  id: "gid://shopify/Order/555", name: "#1002", createdAt: "2026-10-29T09:05:00Z", cancelledAt: null,
  displayFinancialStatus: "PARTIALLY_PAID", displayFulfillmentStatus: "UNFULFILLED", paymentGatewayNames: ["Cash on Delivery (COD)"], discountCodes: ["WELCOME10"],
  email: "riya@example.com", phone: null,
  subtotalPriceSet: money("450.00"), totalShippingPriceSet: money("50"), totalTaxSet: money("0"), totalDiscountsSet: money("45"), totalPriceSet: money("500.00"), totalRefundedSet: money("0"),
  shippingLine: { title: "Standard" },
  shippingAddress: { name: "Riya", address1: "12 MG Road", city: "Pune", province: "MH", zip: "411001", country: "India", phone: "+91 98" },
  billingAddress: null,
  lineItems: { nodes: [{ title: "Earbuds", variantTitle: "Black", quantity: 2, originalUnitPriceSet: money("250"), discountedUnitPriceSet: money("225") }, { title: "Cable", variantTitle: "Default Title", quantity: 1, originalUnitPriceSet: money("50"), discountedUnitPriceSet: null }] },
  fulfillments: [{ status: "SUCCESS", displayStatus: "IN_TRANSIT", createdAt: "2026-10-30T00:00:00Z", trackingInfo: [{ company: "Delhivery", number: "DL1", url: "https://t/DL1" }, {}] }],
};

test("a Shopify order becomes plain facts: lines, amounts, address, tracking, readable statuses", () => {
  const o = presentOrder(node);
  assert.deepEqual([o.name, o.shopifyId, o.paymentStatus, o.fulfillmentStatus], ["#1002", "555", "partially paid", "unfulfilled"]);
  assert.deepEqual(o.items.map((i) => [i.title, i.variant, i.quantity, i.unitPrice.amount, i.lineTotal.amount]), [["Earbuds", "Black", 2, 225, 450], ["Cable", "", 1, 50, 50]]);
  assert.deepEqual(o.amounts.total, { amount: 500, currency: "INR" });
  assert.equal(o.shippingMethod, "Standard");
  assert.deepEqual(o.shippingAddress.lines, ["12 MG Road", "Pune, MH, 411001", "India"]);
  assert.equal(o.billingAddress, null);
  assert.deepEqual(o.shipments[0].tracking, [{ company: "Delhivery", number: "DL1", url: "https://t/DL1" }]);
  assert.equal(o.shipments[0].status, "in transit");
});

test("only an order this store's chats placed can be opened, and the number can't be used to search wider", async () => {
  const lookup = { findOrder: async () => node };
  assert.equal((await orderDetails(A, "#1002", { analytics, lookup, Events: Events() })).order.name, "#1002");
  assert.equal(await orderDetails(A, "1003", { analytics, lookup, Events: Events() }), null);
  assert.equal(await orderDetails("b-store.myshopify.com", "1002", { analytics, lookup, Events: Events() }), null);
  await assert.rejects(orderDetails(A, "not-a-number", { analytics, lookup, Events: Events() }), (e) => e instanceof OrderLookupError && e.status === 400);
});

test("when Shopify no longer has the order the chat's own record still shows, with a note", async () => {
  const r = await orderDetails(A, "1002", { analytics, lookup: { findOrder: async () => null }, Events: Events() });
  assert.equal(r.order, null);
  assert.equal(r.recorded.total, 500);
  assert.match(r.notice, /could not find/);
});

test("a Shopify failure becomes a friendly error, and a missing permission says so", async () => {
  const failing = (e) => orderDetails(A, "1002", { analytics, lookup: { findOrder: async () => { throw e; } }, Events: Events() });
  await assert.rejects(failing(new Error("boom 500")), /did not answer/);
  await assert.rejects(failing(Object.assign(new Error("denied"), { code: "SHOPIFY_ACCESS_DENIED" })), /not allowed this app to read order details/);
});

test("statuses for a page of orders come from one Shopify call; failure or a slow answer gives none", async () => {
  const calls = [];
  const graphql = async (shop, query, vars) => { calls.push(vars); return { orders: { nodes: [{ name: "#1002", cancelledAt: null, displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED" }] } }; };
  assert.deepEqual(await orderStatuses(A, ["#1002", "#1001", "#1002"], { graphql }), { 1002: { payment: "paid", fulfillment: "fulfilled", cancelled: false } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, "name:#1002 OR name:#1001");
  assert.deepEqual(await orderStatuses(A, [], { graphql }), {});
  assert.deepEqual(await orderStatuses(A, ["#1"], { graphql: async () => { throw new Error("x"); } }), {});
  assert.deepEqual(await orderStatuses(A, ["#1"], { graphql: () => new Promise(() => {}), waitMs: 20 }), {});
});
