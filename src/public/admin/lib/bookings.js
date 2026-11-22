// Calls the shopper asked for, and what the agent showed in a chat, as the screens say them.
// No UI code, so the wording and the rules (which buttons a call gets) are tested on their own.
import {formatMoney} from './format.js';

/** @type {Record<string, {label: string, tone: 'caution' | 'success' | 'neutral' | 'critical'}>} */
export const CALL_STATUS = {
  requested: {label: 'Waiting for you', tone: 'caution'},
  confirmed: {label: 'Confirmed', tone: 'success'},
  completed: {label: 'Done', tone: 'neutral'},
  missed: {label: 'Missed', tone: 'critical'},
  cancelled: {label: 'Cancelled', tone: 'neutral'},
};

export const CALL_FILTERS = [
  {id: 'requested', label: 'Waiting for you'},
  {id: 'confirmed', label: 'Confirmed'},
  {id: 'completed', label: 'Done'},
  {id: '', label: 'All calls'},
];

/** "Tue, 3 Nov, 10:00 am", always in the time zone the call was booked in. */
/** @param {string | number | undefined} iso @param {string} [timezone] @param {string} [locale] */
export function callWhen(iso, timezone = 'UTC', locale) {
  const date = new Date(iso ?? NaN);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale, {timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'}).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, {timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'}).format(date);
  }
}

/** "Wed 4 Nov, 4:30 to 5:00 PM": the call's own start and end, in the time zone it was booked in. */
/** @param {string | number | undefined} startAt @param {string | number | undefined} endAt @param {string} [timezone] @param {string} [locale] */
export function callSpan(startAt, endAt, timezone = 'UTC', locale = 'en-GB') {
  const start = new Date(startAt ?? NaN);
  if (Number.isNaN(start.getTime())) return '';
  const zone = (() => { try { new Intl.DateTimeFormat(locale, {timeZone: timezone}); return timezone; } catch { return 'UTC'; } })();
  const day = new Intl.DateTimeFormat(locale, {timeZone: zone, weekday: 'short', day: 'numeric', month: 'short'}).format(start);
  const clock = (/** @type {Date} */ d) => new Intl.DateTimeFormat('en-US', {timeZone: zone, hour: 'numeric', minute: '2-digit'}).format(d);
  const end = new Date(endAt ?? NaN);
  if (Number.isNaN(end.getTime())) return `${day}, ${clock(start)}`;
  const [from, fromAmPm] = clock(start).split(' ');
  const [to, toAmPm] = clock(end).split(' ');
  return `${day}, ${fromAmPm === toAmPm ? from : `${from} ${fromAmPm}`} to ${to} ${toAmPm}`;
}

/** What happened to the calendar event, in words the owner can act on. */
/** @param {import('../types.js').Booking} b */
export function calendarNote(b) {
  const c = b.calendar || {status: 'pending', link: '', error: ''};
  if (b.status === 'cancelled') return {text: 'Removed from your calendar', tone: 'neutral', retry: false, link: ''};
  if (c.status === 'synced') return {text: 'In your Google Calendar', tone: 'success', retry: false, link: c.link || ''};
  if (c.status === 'failed') return {text: `Not in your calendar${c.error ? `: ${c.error}` : ''}`, tone: 'critical', retry: true, link: ''};
  if (c.status === 'off') return {text: 'Google Calendar is not connected', tone: 'neutral', retry: false, link: ''};
  return {text: 'Goes to your calendar when you confirm', tone: 'neutral', retry: false, link: ''};
}

/** @param {import('../types.js').Booking} b */
export function emailNote(b) {
  const e = b.emails?.customer || 'none';
  if (e === 'sent') return {text: `Confirmation emailed to ${b.email}`, tone: 'success', retry: false};
  if (e === 'failed') return {text: 'The confirmation email did not send', tone: 'critical', retry: true};
  if (e === 'off') return {text: 'Email is not set up, so no confirmation was sent', tone: 'neutral', retry: false};
  return {text: 'Emailed to the customer once you confirm', tone: 'neutral', retry: false};
}

/**
 * One call as a card needs it, with the buttons that make sense for its state:
 * a request can be confirmed or moved; a confirmed call can be retried (if the calendar or email failed), moved, or closed.
 * @param {import('../types.js').Booking} b
 * @param {{now?: number, locale?: string}} [options]
 */
export function callView(b, {now = Date.now(), locale} = {}) {
  const status = CALL_STATUS[b.status] || CALL_STATUS.requested;
  const open = b.status === 'requested' || b.status === 'confirmed';
  const calendar = calendarNote(b);
  const email = emailNote(b);
  const retry = b.status === 'confirmed' && (calendar.retry || email.retry);
  /** @type {{id: string, label: string, primary?: boolean, tone?: 'critical'}[]} */
  const actions = [];
  if (b.status === 'requested') actions.push({id: 'confirm', label: 'Confirm this time', primary: true});
  if (retry) actions.push({id: 'retry', label: 'Try again', primary: true});
  if (open) actions.push({id: 'change', label: 'Suggest another time'});
  if (b.status === 'confirmed') actions.push({id: 'completed', label: 'Mark as called'});
  if (open) actions.push({id: 'missed', label: 'Could not reach'}, {id: 'cancelled', label: 'Cancel call', tone: 'critical'});
  return {
    id: b.id,
    who: b.name || b.phone || 'Customer',
    contact: [b.phone, b.email].filter(Boolean).join(' · '),
    topic: b.topic || '',
    when: callWhen(b.startAt, b.timezone, locale),
    span: callSpan(b.startAt, b.endAt, b.timezone),
    language: b.language || '',
    asked: b.createdAt || '',
    timezone: b.timezone,
    status: status.label,
    tone: status.tone,
    open,
    overdue: open && new Date(b.endAt).getTime() < now,
    calendar,
    email,
    actions,
    note: b.note || '',
    chatId: b.conversationId,
  };
}

/** The sentence shown after a call action worked. @param {string} action */
export function callDoneText(action) {
  return /** @type {Record<string, string>} */ ({
    confirm: 'Call confirmed',
    retry: 'Tried again',
    change: 'Time changed',
    completed: 'Marked as called',
    missed: 'Marked as not reached',
    cancelled: 'Call cancelled',
  })[action] || 'Saved';
}

/** Choices for "Change time": the owner's free times, grouped into one list. @param {{start: string, local: string}[]} [slots] */
export const slotChoices = (slots = []) => slots.map((s) => ({value: s.start, label: s.local}));

// ---- what the agent showed in a chat ---------------------------------------------------------------------
/** @param {Record<string, any>} a @param {string} timezone */
function actionText(a, timezone) {
  switch (a.type) {
    case 'add_to_cart':
      return `Added ${a.title || 'a product'}${a.quantity > 1 ? ` × ${a.quantity}` : ''} to the cart`;
    case 'begin_checkout':
      return `Started checkout${a.total ? ` (${formatMoney(a.total, a.currency)})` : ''}`;
    case 'apply_discount':
      return a.code ? `Applied the code ${a.code}` : 'Applied a discount';
    case 'payment_link':
      return 'Was given a payment link';
    case 'order_placed': {
      const how = a.paymentMethod === 'cod' ? 'cash on delivery' : a.paymentMethod === 'prepaid' ? 'paid online' : '';
      return `Order ${a.orderId || ''} placed${a.total ? ` (${formatMoney(a.total, a.currency)}${how ? `, ${how}` : ''})` : ''}`.replace(/\s+/g, ' ').trim();
    }
    case 'call_booked':
      return `Asked for a call on ${callWhen(a.startAt, a.timezone || timezone)}`;
    case 'flag_for_owner':
      return a.reason ? `Asked for your team: ${a.reason}` : 'Asked for your team';
    default:
      return '';
  }
}

/**
 * The cards and steps that came with one agent reply: products the shopper was shown (title, price, link) and what the agent did.
 * @param {import('../types.js').ChatMessage['shown']} shown
 * @param {{timezone?: string, currency?: string}} [options]
 */
export function shownView(shown, {timezone = 'UTC', currency = ''} = {}) {
  const products = (shown?.products || []).map((p, i) => ({
    key: `${p.id || p.handle || i}`,
    title: p.title || 'Product',
    image: p.image || '',
    url: p.url || '',
    price: p.price ? formatMoney(p.price, p.currency || currency) : '',
    was: p.compareAtPrice && Number(p.compareAtPrice) > Number(p.price) ? formatMoney(p.compareAtPrice, p.currency || currency) : '',
    outOfStock: p.inStock === false,
  }));
  const steps = (shown?.actions || []).map((a, i) => ({key: `${a.type}-${i}`, text: actionText(a, timezone), call: a.type === 'call_booked', flag: a.type === 'flag_for_owner'})).filter((s) => s.text);
  return {products, steps};
}

// ---- the chats list ------------------------------------------------------------------------------------------
/** The chips above the chats list: the four statuses a chat can have. @type {{id: string, label: string}[]} */
export const INBOX_CHIPS = [
  {id: '', label: 'All'},
  {id: 'waiting', label: 'Waiting on you'},
  {id: 'person', label: 'With a person'},
  {id: 'resolved', label: 'Resolved'},
];

/** Other ways to narrow the list, in one drop-down so the chips stay four. @type {{id: string, label: string}[]} */
export const MORE_FILTERS = [
  {id: 'calls', label: 'Call requests'},
  {id: 'files', label: 'Photos and videos'},
  {id: 'ordered', label: 'Ordered'},
  {id: 'follow_up', label: 'Marked for follow-up'},
];

/** The line under the chats list. */
export const STATUS_NOTE = 'One status per chat: Waiting on you, With a person, AI handling, Resolved. A refund or exchange shows next to it as a tag.';
