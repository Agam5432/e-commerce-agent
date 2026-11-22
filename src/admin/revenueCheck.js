// Where a store's revenue number comes from, order by order: which amount was counted (Shopify's own
// store-currency figure, or the one the chat saw), the two side by side, and anything that looks wrong:
// the same order counted twice, the chat's figure far from Shopify's, an amount far above the store's
// usual order, or no currency. Used by scripts/check-revenue.mjs; reads only.
import Event from "../models/Event.js";
import { moneyOfProps } from "./money.js";
import ecommerce from "../industries/ecommerce.js";

const median = (values) => {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

export async function revenueReport(shop, { Model = Event, analytics = ecommerce.analytics, since = null, limit = 5000 } = {}) {
  const rev = analytics.revenue;
  const filter = { shop, type: rev.event, ...(since ? { at: { $gte: since } } : {}) };
  const events = await Model.find(filter).sort({ at: 1 }).limit(limit).lean();
  const rows = events.map((e) => {
    const p = e.props || {};
    const counted = moneyOfProps(rev, p);
    return {
      at: e.at,
      order: String(p.orderName || ""),
      counted: counted.amount,
      currency: counted.currency,
      shopify: typeof p.shopTotal === "number" ? { amount: p.shopTotal, currency: p.shopCurrency || "" } : null,
      chat: typeof p.total === "number" ? { amount: p.total, currency: p.currency || "" } : null,
      source: p.source || "",
      dedupeKey: e.dedupeKey || "",
      flags: [],
    };
  });
  const byCurrency = {};
  for (const r of rows) byCurrency[r.currency || "?"] = Math.round(((byCurrency[r.currency || "?"] || 0) + r.counted) * 100) / 100;
  const typical = {};
  for (const code of Object.keys(byCurrency)) typical[code] = median(rows.filter((r) => (r.currency || "?") === code && r.counted > 0).map((r) => r.counted));

  const seen = new Map();
  for (const r of rows) {
    if (!r.currency) r.flags.push("no currency");
    if (!r.dedupeKey) r.flags.push("no dedupe key (could be counted twice)");
    if (r.order) {
      seen.set(r.order, (seen.get(r.order) || 0) + 1);
    } else r.flags.push("no order number");
    if (r.shopify && r.chat && r.shopify.currency === r.chat.currency && r.shopify.amount > 0) {
      const ratio = r.chat.amount / r.shopify.amount;
      if (ratio > 5 || ratio < 0.2) r.flags.push(`chat amount ${r.chat.amount} vs Shopify ${r.shopify.amount} (x${ratio.toFixed(1)})`);
    }
    const usual = typical[r.currency || "?"];
    if (usual > 0 && r.counted > usual * 20) r.flags.push(`${Math.round(r.counted / usual)}x the usual order (${usual})`);
    if (!r.shopify) r.flags.push("Shopify's own figure missing (orders/create webhook not received)");
  }
  for (const r of rows) if (r.order && seen.get(r.order) > 1) r.flags.push(`order ${r.order} counted ${seen.get(r.order)} times`);

  const flagged = rows.filter((r) => r.flags.length);
  return { shop, orders: rows.length, byCurrency, typicalOrder: typical, flagged, rows };
}
