// Turns people from the backend into rows and sentences. No UI code, so it is tested on its own.
import {formatAgo, formatMoney, formatWhen} from './format.js';
import {contactLine, outcomeLabel, outcomeTone, personDetail, personLabel} from './chats.js';

/** @type {Record<string, string>} */
const KINDS = {customer: 'Signed in (verified)', guest: 'Guest (email not verified)', visitor: 'Visitor (this browser)'};
/** @type {Record<string, 'success' | 'info' | 'neutral'>} */
const KIND_TONES = {customer: 'success', guest: 'info', visitor: 'neutral'};

export const SORTS = [
  {id: 'recent', label: 'Most recent'},
  {id: 'spend', label: 'Biggest spenders'},
  {id: 'chats', label: 'Most chats'},
];
export const TYPES = [
  {id: '', label: 'Everyone'},
  {id: 'customer', label: 'Signed-in customers'},
  {id: 'guest', label: 'Guests and visitors'},
];

/** "₹1,500", or "₹1,500 + $20" when someone paid in more than one currency (never added together). */
/** @param {import('../types.js').Person} p @param {string} [locale] */
export function spendText(p, locale) {
  const by = Object.entries(p.spendByCurrency || {}).filter(([, amount]) => amount > 0);
  if (!by.length) return '—';
  const main = p.spend?.currency;
  by.sort(([a], [b]) => (a === main ? -1 : b === main ? 1 : a.localeCompare(b)));
  return by.map(([code, amount]) => formatMoney(amount, code, locale)).join(' + ');
}

/**
 * One row of the customers list.
 * @param {import('../types.js').Person} p
 * @param {{timezone?: string, now?: number, locale?: string}} [options]
 */
export function customerRow(p, {timezone = 'UTC', now = Date.now(), locale} = {}) {
  const contact = {name: p.name, email: p.email, phone: p.phone};
  return {
    id: p.id,
    who: personLabel(contact, p.kind === 'customer'),
    detail: personDetail(contact),
    line: contactLine(contact),
    kind: KINDS[p.kind] || 'Visitor',
    kindTone: KIND_TONES[p.kind] || 'neutral',
    chats: p.chats,
    orders: p.orders,
    spend: spendText(p, locale),
    lastSeen: formatAgo(p.lastSeen, timezone, now, locale),
    firstSeen: formatWhen(p.firstSeen, timezone, now, locale),
    result: outcomeLabel(p.bestOutcome),
    resultTone: outcomeTone(p.bestOutcome),
    needsFollowUp: Boolean(p.needsFollowUp),
    voiceChats: p.voiceChats || 0,
    humanCalls: p.humanCalls || 0,
    aiVoiceSessions: p.aiVoiceSessions || 0,
  };
}

/** One sentence about the person for the top of their page. */
/** @param {import('../types.js').Person} p */
export function customerSummary(p) {
  const chats = `${p.chats} ${p.chats === 1 ? 'chat' : 'chats'}`;
  const orders = p.orders ? `${p.orders} ${p.orders === 1 ? 'order' : 'orders'}` : 'no orders yet';
  return `${chats}, ${orders}`;
}

/** Rows for the person's own orders table (their orders carry no "customer" column: it is them). */
/** @param {import('../types.js').OrderEvent} o */
export const orderTotal = (o) => (o.shopTotal != null && o.shopCurrency ? formatMoney(o.shopTotal, o.shopCurrency) : o.total != null ? formatMoney(o.total, o.currency) : '—');
