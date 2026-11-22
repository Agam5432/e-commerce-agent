// The revenue check explains a store's number order by order and flags what looks wrong.
import test from "node:test";
import assert from "node:assert/strict";
import { revenueReport } from "../src/admin/revenueCheck.js";

const events = (rows) => ({ find: () => ({ sort: () => ({ limit: () => ({ lean: async () => rows }) }) }) });
const order = (name, props, dedupe = true) => ({ at: new Date("2026-11-01"), dedupeKey: dedupe ? `order:${name}` : undefined, props: { orderName: name, source: "agent", ...props } });

test("each order shows which figure was counted, and the oddities are flagged", async () => {
  const report = await revenueReport("a.myshopify.com", {
    Model: events([
      order("#1001", { total: 1200, currency: "INR", shopTotal: 1200, shopCurrency: "INR" }),
      order("#1002", { total: 1500, currency: "INR", shopTotal: 1500, shopCurrency: "INR" }),
      order("#1003", { total: 150000, currency: "INR", shopTotal: 1500, shopCurrency: "INR" }),
      order("#1004", { total: 99000000, currency: "INR" }),
      order("#1002", { total: 1500, currency: "INR" }, false),
    ]),
  });
  assert.equal(report.orders, 5);
  const by = (name) => report.rows.filter((r) => r.order === name);
  assert.equal(by("#1003")[0].counted, 1500, "Shopify's own figure wins");
  assert.match(by("#1003")[0].flags.join(), /chat amount 150000 vs Shopify 1500 \(x100\.0\)/);
  assert.match(by("#1004")[0].flags.join(), /x the usual order/);
  assert.match(by("#1004")[0].flags.join(), /webhook not received/);
  assert.ok(by("#1002").every((r) => r.flags.some((f) => /counted 2 times/.test(f))));
  assert.match(by("#1002")[1].flags.join(), /no dedupe key/);
  assert.equal(by("#1001")[0].flags.length, 0);
  assert.equal(report.byCurrency.INR, 1200 + 1500 + 1500 + 99000000 + 1500);
});
