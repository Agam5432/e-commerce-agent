// Turns the overview answer from the backend into what the screen draws. Kept free of any UI code
// so the numbers and the chart geometry can be tested on their own.
import {chatsLink} from './links.js';

/** @type {Record<string, string>} */
const STAGE_LABELS = {
  conversation_started: 'Chatted',
  products_shown: 'Saw products',
  cart_add: 'Added to cart',
  checkout_started: 'Reached checkout',
  order_placed: 'Ordered',
};

/** @param {string} id */
const humanize = (id) => String(id).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Bars for "Where chats end up": width is the share of chats that started, never below 2% so a bar stays visible. */
/** @param {import('../types.js').FunnelStep[]} [funnel] */
export function funnelBars(funnel = []) {
  const first = funnel[0]?.conversations || 0;
  return funnel.map((step, i) => ({
    stage: step.stage,
    label: STAGE_LABELS[step.stage] || humanize(step.stage),
    count: step.conversations,
    percent: first ? Math.max(step.conversations ? 2 : 0, Math.round((step.conversations / first) * 100)) : 0,
    last: i === funnel.length - 1,
  }));
}

/** A round top for a chart axis (1, 2, 5, 10, 20, 25, 50...) that splits into four equal steps, so the grid labels read cleanly. @param {number} n */
export function niceMax(n) {
  const value = Math.max(1, Number(n) || 0);
  const magnitude = Math.max(1, 10 ** Math.floor(Math.log10(value / 4)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * magnitude * 4 >= value) return m * magnitude * 4;
  }
  return 10 * magnitude * 4;
}

/** Points for two line charts that share one picture. Each line has its own scale, so orders are readable beside chats. */
/**
 * @param {import('../types.js').DayPoint[]} [series]
 * @param {{width?: number, height?: number, left?: number, right?: number, top?: number, bottom?: number}} [box]
 */
export function chartLines(series = [], {width = 640, height = 230, left = 20, right = 10, top = 20, bottom = 28, nice = false} = {}) {
  const innerW = width - left - right;
  const innerH = height - top - bottom;
  /** @param {number} i */
  const x = (i) => (series.length <= 1 ? left + innerW / 2 : left + (i / (series.length - 1)) * innerW);
  /** @param {'conversations' | 'orders'} key */
  const line = (key) => {
    const top_ = Math.max(1, ...series.map((d) => d[key] || 0));
    const max = nice ? niceMax(top_) : top_;
    return series.map((d, i) => `${Math.round(x(i) * 10) / 10},${Math.round((top + innerH - ((d[key] || 0) / max) * innerH) * 10) / 10}`).join(' ');
  };
  const pick = series.length ? [0, Math.floor((series.length - 1) / 2), series.length - 1] : [];
  return {
    chats: line('conversations'),
    orders: line('orders'),
    labels: [...new Set(pick)].map((i) => ({x: x(i), date: series[i].date})),
    baseline: top + innerH,
    top,
    width,
    height,
    left,
    right: width - right,
    maxChats: Math.max(0, ...series.map((d) => d.conversations || 0)),
    maxOrders: Math.max(0, ...series.map((d) => d.orders || 0)),
    axisChats: nice ? niceMax(Math.max(1, ...series.map((d) => d.conversations || 0))) : 0,
    axisOrders: nice ? niceMax(Math.max(1, ...series.map((d) => d.orders || 0))) : 0,
  };
}

/** A sentence for screen readers, since the chart is a picture. */
/** @param {import('../types.js').DayPoint[]} [series] */
export function chartSummary(series = []) {
  if (!series.length) return 'No chats in this period.';
  const chats = series.reduce((n, d) => n + (d.conversations || 0), 0);
  const orders = series.reduce((n, d) => n + (d.orders || 0), 0);
  return `Line chart over ${series.length} days: ${chats} chats and ${orders} orders in total.`;
}

/** "Needs your attention": only things that actually need it, each one opening the chats it is about. */
/** @param {Partial<import('../types.js').Totals>} [totals] @param {{from: string, to: string}} [range] */
export function attentionItems(totals = {}, range = {from: '', to: ''}) {
  const items = [];
  const drop = totals.dropoffs?.checkoutNoOrder || 0;
  if (drop > 0) items.push({id: 'checkout', text: `${drop} ${drop === 1 ? 'shopper' : 'shoppers'} reached checkout but did not order`, to: chatsLink('dropoff:checkoutNoOrder', range), action: 'See who'});
  const follow = totals.needsFollowUp || 0;
  if (follow > 0) items.push({id: 'follow', text: `${follow} ${follow === 1 ? 'chat' : 'chats'} waiting on you`, to: chatsLink('needs_follow_up', range), action: 'Open'});
  const failed = totals.failedReplies || 0;
  if (failed > 0) items.push({id: 'failed', text: `${failed} ${failed === 1 ? 'reply' : 'replies'} the agent could not write`, to: chatsLink('failed', range), action: 'Open'});
  return items;
}

/** "12 placed in chat, 2 later on the site" for the orders card; empty when there are no orders. */
/** @param {Record<string, number>} [bySource] */
export function ordersNote(bySource = {}) {
  const inChat = bySource.agent || 0;
  const later = bySource.assisted || 0;
  if (!inChat && !later) return '';
  if (!later) return `All ${inChat} placed in chat`;
  if (!inChat) return `All ${later} placed later on the site`;
  return `${inChat} placed in chat, ${later} later on the site`;
}
