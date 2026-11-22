// Turns chats from the backend into what the screens show: who it was, what happened, how it ended.
// No UI code, so it is tested on its own.
import {formatAgo, formatMoney, formatWhen} from './format.js';

/** @param {string} v */
const humanize = (v) => String(v || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** @type {Record<string, string>} */
const OUTCOMES = {
  chat: 'Just chatted',
  products_shown: 'Looked at products',
  cart_add: 'Added to the cart',
  checkout_started: 'Reached checkout',
  payment_link_created: 'Got a payment link',
  order_placed: 'Placed an order',
  call_booked: 'Asked for a call',
};
/** @type {Record<string, 'success' | 'info' | 'call' | 'caution' | 'neutral'>} */
const OUTCOME_TONES = {order_placed: 'success', call_booked: 'call', checkout_started: 'caution', payment_link_created: 'caution', cart_add: 'info', products_shown: 'neutral', chat: 'neutral'};

export const STATUSES = [
  {id: 'open', label: 'Open'},
  {id: 'needs_human', label: 'Needs follow-up'},
  {id: 'resolved', label: 'Resolved'},
];
/** @type {Record<string, 'success' | 'critical' | 'neutral'>} */
const STATUS_TONES = {open: 'neutral', needs_human: 'critical', resolved: 'success'};

/** @param {string} [outcome] */
export const outcomeLabel = (outcome) => OUTCOMES[outcome || 'chat'] || humanize(outcome || 'chat');
/** @param {string} [outcome] */
export const outcomeTone = (outcome) => OUTCOME_TONES[outcome || 'chat'] || 'neutral';
/** @param {string} [status] */
export const statusLabel = (status) => STATUSES.find((s) => s.id === status)?.label || humanize(status || 'open');
/** @param {string} [status] */
export const statusTone = (status) => STATUS_TONES[status || 'open'] || 'neutral';

/**
 * Who this is, as the owner would say it: the name, else the email, else the phone, else "Visitor"
 * (or "Signed-in customer" when Shopify knows them but we hold no name).
 * @param {{name?: string, email?: string, phone?: string} | null | undefined} contact
 * @param {boolean} [signedIn]
 */
export function personLabel(contact, signedIn = false) {
  return contact?.name || contact?.email || contact?.phone || (signedIn ? 'Signed-in customer' : 'Visitor');
}

/** A line under the name: the other contact details, so two people with the same name can be told apart. */
/** @param {{name?: string, email?: string, phone?: string} | null | undefined} contact */
export function personDetail(contact) {
  const parts = [contact?.name ? contact.email : '', contact?.phone].filter(Boolean);
  return parts.join(' · ');
}

/** The one way to reach them that a list row shows: their email, or their phone when there is no email. */
export function contactLine(contact) {
  return (contact?.name ? contact.email : '') || contact?.phone || '';
}

const CHANNELS = {text: 'Text', voice: 'Voice'};
const LANGUAGES = {en: 'English', hi: 'Hindi', hinglish: 'Hinglish'};

/** @param {string} [code] */
export const languageLabel = (code) => (code ? LANGUAGES[/** @type {'en'} */ (code)] || code.toUpperCase() : '');

/**
 * One row of the chats list.
 * @param {import('../types.js').ConversationSummary} chat
 * @param {{timezone?: string, now?: number, locale?: string}} [options]
 */
export function chatRow(chat, {timezone = 'UTC', now = Date.now(), locale} = {}) {
  const preview = String(chat.firstMessage || '').trim();
  return {
    id: chat.id,
    who: personLabel(chat.contact, chat.verifiedCustomer),
    detail: personDetail(chat.contact),
    line: contactLine(chat.contact),
    personKey: chat.personKey,
    // "Signed in" when Shopify knows the shopper, "Guest" when they only gave contact details, nothing for an unknown visitor
    kind: chat.verifiedCustomer ? 'Signed in' : chat.contact?.name || chat.contact?.email || chat.contact?.phone ? 'Guest' : '',
    preview: preview ? (preview.length > 70 ? `${preview.slice(0, 67)}…` : preview) : 'No message saved',
    when: formatAgo(chat.lastMessageAt, timezone, now, locale),
    started: formatWhen(chat.startedAt, timezone, now, locale),
    channel: CHANNELS[/** @type {'text'} */ (chat.channel)] || humanize(chat.channel),
    messages: chat.messageCount ?? 0,
    result: outcomeLabel(chat.outcome),
    resultTone: outcomeTone(chat.outcome),
    status: statusLabel(chat.status),
    statusTone: statusTone(chat.status),
    failed: chat.failedReplies || 0,
    cleared: Boolean(chat.clearedByCustomer),
    tags: chatTags(chat),
    state: chatState(chat),
    request: requestTag(chat),
    reason: String(chat.flags?.reason || '').trim(),
    need: needKind(chat),
  };
}

/**
 * The one word on a to-do row that says what the chat is about: the refund / exchange asked for, a call back, photos
 * the shopper sent, or just a question the agent could not settle.
 * @param {import('../types.js').ConversationSummary} chat
 * @returns {{text: string, tone: 'caution' | 'info' | 'neutral'}}
 */
export function needKind(chat) {
  if (chat.case?.type) return {text: humanize(chat.case.type), tone: 'caution'};
  if (chat.flags?.callRequested) return {text: 'Call back', tone: 'info'};
  if ((chat.fileCount || 0) > 0) return {text: 'Photos', tone: 'info'};
  return {text: 'Question', tone: 'neutral'};
}

/**
 * ONE status for a chat, in the owner's words: waiting on you, with a person (someone from the team has it), the AI
 * is handling it, or resolved. The refund / exchange the shopper asked for is a tag beside it, not a second status.
 * @param {import('../types.js').ConversationSummary} chat
 * @returns {{id: 'resolved' | 'person' | 'waiting' | 'ai', label: string, tone: 'success' | 'info' | 'caution' | 'neutral'}}
 */
export function chatState(chat) {
  if (chat.status === 'resolved') return {id: 'resolved', label: 'Resolved', tone: 'success'};
  if (chat.handoff?.active) return {id: 'person', label: 'With a person', tone: 'info'};
  if (chat.flags?.needsFollowUp || chat.flags?.callRequested || chat.status === 'needs_human') return {id: 'waiting', label: 'Waiting on you', tone: 'caution'};
  return {id: 'ai', label: 'AI handling', tone: 'neutral'};
}

/** "Refund · Approved", for a chat the owner is following up on. Null when there is no such request. */
export function requestTag(chat) {
  const c = chat.case;
  if (!c || !(c.type || c.status)) return null;
  const word = (v) => humanize(v || '').toLowerCase().replace(/^./, (x) => x.toUpperCase());
  return {text: `${word(c.type || 'other')} · ${word(c.status || 'received')}`, tone: c.status === 'completed' || c.status === 'approved' ? 'success' : c.status === 'rejected' ? 'critical' : 'caution'};
}

/** The labels on a chat row: what needs the owner (a call, a follow-up, files). */
/** @param {import('../types.js').ConversationSummary} chat */
export function chatTags(chat) {
  /** @type {{id: string, text: string, tone: 'info' | 'call' | 'caution' | 'neutral'}[]} */
  const tags = [];
  if (chat.handoff?.active) tags.push({id: 'person', text: 'A person has this chat', tone: 'info'});
  if (chat.flags?.callRequested) tags.push({id: 'call', text: 'Call requested', tone: 'call'});
  if (chat.flags?.needsFollowUp && chat.status !== 'resolved') tags.push({id: 'follow', text: 'Needs follow-up', tone: 'caution'});
  if ((chat.fileCount || 0) > 0) tags.push({id: 'files', text: `${chat.fileCount} ${chat.fileCount === 1 ? 'file' : 'files'}`, tone: 'info'});
  return tags;
}

/** @param {number} bytes */
export function fileSize(bytes) {
  const n = Number(bytes) || 0;
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * The conversation as lines to read. A message the agent could not answer is flagged.
 * @param {import('../types.js').ChatMessage[]} messages
 * @param {{timezone?: string, now?: number, locale?: string}} [options]
 */
export function transcriptLines(messages = [], {timezone = 'UTC', now = Date.now(), locale} = {}) {
  return messages.map((m, i) => ({
    key: `${i}-${m.at}`,
    at: m.at,
    who: m.role === 'user' ? 'Customer' : m.role === 'staff' ? 'Team' : 'Agent',
    fromCustomer: m.role === 'user',
    fromTeam: m.role === 'staff',
    text: m.text || '',
    when: formatWhen(m.at, timezone, now, locale),
    failed: Boolean(m.failed),
    attachments: (m.attachments || []).map((a) => ({id: a.id, name: a.name, kind: a.kind, size: fileSize(a.size)})),
    shown: m.shown,
    call: m.call || null,
  }));
}

/**
 * What happened in the chat besides talking, in plain words (the "timeline").
 * @param {import('../types.js').ChatEvent[]} events
 * @param {{timezone?: string, now?: number, locale?: string}} [options]
 */
export function timelineLines(events = [], {timezone = 'UTC', now = Date.now(), locale} = {}) {
  const lines = [];
  for (const [i, e] of events.entries()) {
    const text = eventText(e);
    if (text) lines.push({key: `${i}-${e.at}`, text, at: e.at, when: formatWhen(e.at, timezone, now, locale)});
  }
  return lines;
}

/** @param {import('../types.js').ChatEvent} e */
function eventText(e) {
  const p = e.props || {};
  switch (e.type) {
    case 'conversation_started':
      return 'Chat started';
    case 'products_shown': {
      const names = (p.items || []).map((/** @type {{title?: string}} */ x) => x.title).filter(Boolean);
      return names.length ? `Saw ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}` : `Saw ${p.count || 'some'} products`;
    }
    case 'cart_add':
      return `Added ${p.title || 'a product'} to the cart`;
    case 'checkout_started':
      return 'Reached checkout';
    case 'payment_link_created':
      return 'Was given a payment link';
    case 'call_booked':
      return 'Asked for a call';
    case 'flagged_for_owner':
      return 'Asked for your team';
    case 'order_placed': {
      const amount = p.shopTotal != null && p.shopCurrency ? formatMoney(p.shopTotal, p.shopCurrency) : p.total != null ? formatMoney(p.total, p.currency) : '';
      return `Placed order ${p.orderName || ''}${amount ? ` (${amount})` : ''}`.trim();
    }
    default:
      return '';
  }
}

/**
 * What the reply box under a chat should say and allow.
 * @param {{handoff?: {active?: boolean}, status?: string, clearedByCustomer?: boolean}} [chat]
 */
export function replyBox(chat = {}) {
  if (chat.clearedByCustomer) return {canReply: false, active: false, reopens: false, hint: 'The customer cleared this chat, so they can no longer receive replies.'};
  const active = Boolean(chat.handoff?.active);
  return {
    canReply: true,
    active,
    reopens: chat.status === 'resolved',
    hint: active
      ? 'You have this chat. The AI will not answer this customer until you hand it back.'
      : 'Sending a message takes over this chat: the AI stops answering this customer until you hand it back.',
  };
}

// ---- refund / exchange requests the owner follows up -------------------------------------------
export const CASE_TYPES = [
  {id: 'refund', label: 'Refund'},
  {id: 'exchange', label: 'Exchange'},
  {id: 'return', label: 'Return'},
  {id: 'replacement', label: 'Replacement'},
  {id: 'other', label: 'Other'},
];
export const CASE_STATUSES = [
  {id: 'received', label: 'Received'},
  {id: 'in_progress', label: 'In progress'},
  {id: 'approved', label: 'Approved'},
  {id: 'completed', label: 'Completed'},
  {id: 'rejected', label: 'Rejected'},
];
/** @type {Record<string, 'success' | 'critical' | 'caution' | 'neutral'>} */
const CASE_TONES = {received: 'neutral', in_progress: 'caution', approved: 'success', completed: 'success', rejected: 'critical'};
/** @param {string} [status] */
export const caseTone = (status) => CASE_TONES[status || 'received'] || 'neutral';
/** @param {string} [status] */
export const caseStatusLabel = (status) => CASE_STATUSES.find((s) => s.id === status)?.label || humanize(status || 'received');

/** "Replacement request" once a type is saved, else the plain heading. @param {{type?: string} | null | undefined} saved */
export const caseTitle = (saved) => (saved?.type ? `${CASE_TYPES.find((t) => t.id === saved.type)?.label || humanize(saved.type)} request` : 'Refund or exchange request');

/**
 * What the form starts with, and whether saving would change anything.
 * @param {{type?: string, status?: string, note?: string} | null | undefined} saved
 * @param {{type: string, status: string, note: string}} draft
 */
export const caseDraft = (saved) => ({type: saved?.type || 'refund', status: saved?.status || 'received', note: saved?.note || ''});
export const caseChanged = (saved, draft) => !saved || saved.type !== draft.type || saved.status !== draft.status || (saved.note || '') !== draft.note.trim();
