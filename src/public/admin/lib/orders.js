// Turns the orders list from the backend into table rows. No UI code, so it is tested on its own.
import {formatDate, formatMoney, formatWhen} from './format.js';
import {personDetail, personLabel} from './chats.js';

/** @type {Record<string, string>} */
const PLACED_BY = {agent: 'Agent', assisted: 'Assisted, ordered later'};
/** @type {Record<string, string>} */
const PAYMENT = {cod: 'Cash on delivery', prepaid: 'Prepaid', online: 'Online', payment_link: 'Payment link', paid: 'Online'};

/** @param {unknown} v */
const humanize = (v) => String(v || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** One table row. The amount is the store-currency one when Shopify reported it, else what the shopper paid. */
/**
 * @param {import('../types.js').OrderEvent} [order]
 * @param {{timezone?: string, now?: number, locale?: string}} [options]
 */
export function orderRow(order = {}, {timezone = 'UTC', now = Date.now(), locale} = {}) {
  const inStore = order.shopTotal != null && order.shopCurrency;
  return {
    key: `${order.orderName || ''}-${order.at || ''}`,
    order: order.orderName || '—',
    date: formatWhen(order.at, timezone, now, locale),
    placedBy: PLACED_BY[order.source || ''] || (order.source ? humanize(order.source) : '—'),
    payment: PAYMENT[order.paymentMethod || ''] || (order.paymentMethod ? humanize(order.paymentMethod) : '—'),
    items: order.items ?? '—',
    badges: statusBadges(order.status),
    total: inStore ? formatMoney(order.shopTotal, order.shopCurrency, locale) : order.total != null ? formatMoney(order.total, order.currency, locale) : '—',
    conversationId: order.conversationId || null,
    customer: order.customer ? personLabel(order.customer) : '—',
    customerDetail: order.customer ? personDetail(order.customer) : '',
    customerKey: order.customer?.personKey || null,
  };
}

/** "12 of 14": orders the agent placed itself, out of all orders that came from chats. */
/** @param {Record<string, number>} [bySource] @param {number} [total] */
export function placedByAgent(bySource = {}, total = 0) {
  return `${bySource.agent || 0} of ${total || 0}`;
}

/** @param {string} [method] */
export const paymentLabel = (method) => PAYMENT[method || ''] || (method ? humanize(method) : '—');

/** The "Payment" choices: only the ways orders were really paid in this store (from the counts), plus "Any payment". */
/** @param {Record<string, number>} [byPayment] */
export function paymentOptions(byPayment = {}) {
  const methods = Object.keys(byPayment).filter((m) => m && m !== 'unknown' && byPayment[m] > 0).sort();
  return [{id: '', label: 'Any payment'}, ...methods.map((m) => ({id: m, label: paymentLabel(m)}))];
}

/**
 * "Paid online / cash on delivery": how many orders were paid before delivery and how many on delivery.
 * An order whose payment was not recorded is in neither, so the two can add up to less than the total.
 * @param {Record<string, number>} [byPayment]
 */
export function paidVsCod(byPayment = {}) {
  const cod = byPayment.cod || 0;
  const online = Object.entries(byPayment).reduce((n, [method, count]) => (method === 'cod' || method === 'unknown' ? n : n + (count || 0)), 0);
  return {online, cod, text: `${online} / ${cod}`};
}

// ---- Shopify's side of an order: payment and delivery status, and the full detail page ------------

/** @type {Record<string, 'success' | 'caution' | 'info' | 'critical' | 'neutral'>} */
const PAYMENT_TONE = {paid: 'success', 'partially paid': 'caution', pending: 'caution', authorized: 'caution', 'partially refunded': 'neutral', refunded: 'neutral', voided: 'neutral', expired: 'critical'};
/** @type {Record<string, 'success' | 'caution' | 'info' | 'critical' | 'neutral'>} */
const DELIVERY_TONE = {fulfilled: 'success', delivered: 'success', 'partially fulfilled': 'info', 'in progress': 'info', scheduled: 'info', 'in transit': 'info', 'out for delivery': 'info', unfulfilled: 'caution', 'on hold': 'caution', 'request declined': 'critical', failure: 'critical'};

/** @param {string} [text] */
const sentence = (text) => String(text || '').replace(/^./, (c) => c.toUpperCase());

/**
 * The two status badges for an order row, or nothing when Shopify did not say.
 * @param {{payment?: string | null, fulfillment?: string | null, cancelled?: boolean} | null} [status]
 */
export function statusBadges(status) {
  if (!status) return [];
  if (status.cancelled) return [{key: 'cancelled', label: 'Cancelled', tone: 'critical'}];
  /** @type {{key: string, label: string, tone: string}[]} */
  const out = [];
  if (status.payment) out.push({key: 'payment', label: sentence(status.payment), tone: PAYMENT_TONE[status.payment] || 'neutral'});
  if (status.fulfillment) out.push({key: 'fulfillment', label: sentence(status.fulfillment), tone: DELIVERY_TONE[status.fulfillment] || 'neutral'});
  return out;
}

/** @param {{amount: number, currency: string} | null | undefined} m @param {string} [locale] */
const price = (m, locale) => (m ? formatMoney(m.amount, m.currency, locale) : '—');

/**
 * Everything the order page shows, as plain strings. `data` is the backend's `{recorded, order, notice}`.
 * @param {any} data
 * @param {{timezone?: string, now?: number, locale?: string, handle?: string}} [options]
 */
export function orderDetailView(data, {timezone = 'UTC', now = Date.now(), locale, handle = ''} = {}) {
  const {recorded = {}, order = null, notice = '', customerCancel = null} = data || {};
  const name = order?.name || recorded.orderName || '—';
  const a = order?.amounts || {};
  const hasAmount = (m) => m && m.amount > 0;
  /** @type {{label: string, value: string, strong?: boolean}[]} */
  const summary = order ? [
    {label: 'Subtotal', value: price(a.subtotal, locale)},
    ...(hasAmount(a.discounts) ? [{label: order.discountCodes?.length ? `Discount (${order.discountCodes.join(', ')})` : 'Discount', value: `−${price(a.discounts, locale)}`}] : []),
    {label: order.shippingMethod ? `Shipping (${order.shippingMethod})` : 'Shipping', value: hasAmount(a.shipping) ? price(a.shipping, locale) : 'Free'},
    ...(hasAmount(a.tax) ? [{label: 'Tax', value: price(a.tax, locale)}] : []),
    {label: 'Total', value: price(a.total, locale), strong: true},
    ...(hasAmount(a.refunded) ? [{label: 'Refunded', value: `−${price(a.refunded, locale)}`}] : []),
  ] : [
    {label: 'Total', value: recorded.shopTotal != null && recorded.shopCurrency ? formatMoney(recorded.shopTotal, recorded.shopCurrency, locale) : recorded.total != null ? formatMoney(recorded.total, recorded.currency, locale) : '—', strong: true},
  ];
  const placedAt = order?.createdAt || recorded.at;
  return {
    name,
    placed: placedAt ? formatWhen(placedAt, timezone, now, locale) : '—',
    placedBy: PLACED_BY[recorded.source || ''] || (recorded.source ? humanize(recorded.source) : '—'),
    notice,
    badges: order ? (statusBadges({payment: order.paymentStatus, fulfillment: order.fulfillmentStatus, cancelled: Boolean(order.cancelledAt)})) : [],
    cancelNote: order?.cancelledAt ? `Cancelled ${formatWhen(order.cancelledAt, timezone, now, locale)}${order.cancelReason ? `, ${order.cancelReason}` : ''}` : '',
    // what the customer told the assistant when cancelling: their own words, shown as written
    cancelReason: customerCancel?.reason || '',
    cancelledThrough: customerCancel ? 'AI Assistant' : '',
    cancelRequested: customerCancel?.at ? formatWhen(customerCancel.at, timezone, now, locale) : '',
    items: (order?.items || []).map((i, n) => ({key: `${n}-${i.title}`, title: i.title, variant: i.variant, quantity: i.quantity, unit: price(i.unitPrice, locale), line: price(i.lineTotal, locale)})),
    itemCount: order ? order.items.reduce((n, i) => n + i.quantity, 0) : recorded.items ?? null,
    summary,
    payment: order?.gateways?.length ? order.gateways.join(', ') : paymentLabel(recorded.paymentMethod),
    contact: [order?.email, order?.phone].filter(Boolean),
    shippingAddress: order?.shippingAddress || null,
    billingAddress: order?.billingAddress || null,
    shipments: (order?.shipments || []).map((s, n) => ({
      key: String(n),
      status: s.status ? sentence(s.status) : 'Shipped',
      shipped: s.shippedAt ? formatDate(s.shippedAt, timezone, now, locale) : '',
      expected: s.estimatedDeliveryAt && !s.deliveredAt ? formatDate(s.estimatedDeliveryAt, timezone, now, locale) : '',
      delivered: s.deliveredAt ? formatDate(s.deliveredAt, timezone, now, locale) : '',
      tracking: s.tracking,
    })),
    conversationId: recorded.conversationId || null,
    shopifyUrl: order?.shopifyId && handle ? `https://admin.shopify.com/store/${handle}/orders/${order.shopifyId}` : '',
  };
}
