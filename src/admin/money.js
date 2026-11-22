// How an order's amount and currency are read. They always travel as a PAIR: the store-currency figure
// (Shopify's own, added when the order webhook arrives) with its currency, or else what the shopper saw
// with its currency. Mixing one of each would call a rupee amount "dollars", which is how a store could
// show $0 sales on one page and lakhs on another.

const NUMBER_TYPES = ["double", "int", "long", "decimal"];
const isNumber = (path) => ({ $in: [{ $type: `$${path}` }, NUMBER_TYPES] });
const isText = (path) => ({ $gt: [{ $strLenCP: { $cond: [{ $eq: [{ $type: `$${path}` }, "string"] }, `$${path}`, ""] } }, 0] });

/** @param {{amount: string | string[], currency: string | string[]}} rev analytics.revenue: pair i is amount[i] with currency[i] */
const pairsOf = (rev) => {
  const amounts = [].concat(rev.amount);
  const currencies = [].concat(rev.currency);
  return amounts.map((amount, i) => ({ amount, currency: currencies[i] ?? currencies[currencies.length - 1] }));
};

/** MongoDB expressions for the amount and the currency of one order event. */
export function moneyExpr(rev) {
  const pairs = pairsOf(rev);
  const build = (i) => {
    const { amount, currency } = pairs[i];
    const last = i === pairs.length - 1;
    const ownAmount = { $cond: [isNumber(amount), `$${amount}`, 0] };
    const ownCurrency = { $cond: [isText(currency), `$${currency}`, ""] };
    if (last) return { amount: ownAmount, currency: ownCurrency };
    const rest = build(i + 1);
    const usable = { $and: [isNumber(amount), isText(currency)] };
    return { amount: { $cond: [usable, `$${amount}`, rest.amount] }, currency: { $cond: [usable, `$${currency}`, rest.currency] } };
  };
  const own = build(0);
  if (!rev.refunded) return own;
  // What Shopify says was refunded (in the store's currency) comes off the amount, but only when the amount itself is in
  // that currency: a refund in rupees is never taken off a figure in dollars.
  const refund = { $cond: [{ $and: [isNumber(rev.refunded), { $eq: [`$${pairs[0].currency}`, own.currency] }] }, `$${rev.refunded}`, 0] };
  return { amount: { $max: [0, { $subtract: [own.amount, refund] }] }, currency: own.currency };
}

/** The filter that leaves out orders that do not count as orders or revenue: cancelled, or refunded in full. */
export const COUNTED_ORDER = { "props.cancelledAt": { $exists: false }, "props.refundedInFull": { $ne: true } };
/** The same rule as a `$nor` clause, for events of the revenue type. */
export const notCountedOrder = (type) => ({ type, $or: [{ "props.cancelledAt": { $exists: true } }, { "props.refundedInFull": true }] });

const read = (props, path) => String(path).replace(/^props\./, "").split(".").reduce((o, k) => (o == null ? undefined : o[k]), props);

// The amount after what Shopify refunded, when the refund is in the same currency as the amount.
function netOfRefund(rev, props, pairs, amount, currency) {
  const refunded = rev.refunded ? read(props, rev.refunded) : undefined;
  if (typeof refunded !== "number" || Number.isNaN(refunded) || read(props, pairs[0].currency) !== currency) return amount;
  return Math.max(0, Math.round((amount - refunded) * 100) / 100);
}

/** The same rule for an event already in memory. @returns {{amount: number, currency: string}} */
export function moneyOfProps(rev, props = {}) {
  const pairs = pairsOf(rev);
  for (let i = 0; i < pairs.length; i++) {
    const amount = read(props, pairs[i].amount);
    const currency = read(props, pairs[i].currency);
    const usable = typeof amount === "number" && !Number.isNaN(amount) && typeof currency === "string" && currency.length > 0;
    if (usable) return { amount: netOfRefund(rev, props, pairs, amount, currency), currency };
    if (i === pairs.length - 1) return { amount: typeof amount === "number" && !Number.isNaN(amount) ? amount : 0, currency: typeof currency === "string" ? currency : "" };
  }
  return { amount: 0, currency: "" };
}

/**
 * The currency to show as THE number: the store's own when it has any sales, otherwise the one with the
 * most sales (so a store never shows $0 while its orders are in another currency).
 * @param {Record<string, number>} byCurrency @param {string} [storeCurrency]
 */
export function pickPrimary(byCurrency = {}, storeCurrency = "") {
  if (storeCurrency && (byCurrency[storeCurrency] || 0) > 0) return storeCurrency;
  const ranked = Object.entries(byCurrency).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] || storeCurrency || Object.keys(byCurrency)[0] || "";
}
