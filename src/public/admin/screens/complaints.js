// Complaints: the problems customers raised in the chat. What they said, the order and product, what the assistant already
// tried, whether the email to you went (and to whom), whether a person was asked for, and the chat itself.
import {actions, screens, state} from '../core.js';
import {getComplaints, resolveComplaint, retryComplaintEmail} from '../api.js';
import {formatWhen} from '../lib/format.js';
import {emptyState, esc, pill, toast} from '../ui.js';

const ui = {filter: 'open', items: [], counts: {open: 0, emailFailed: 0, waitingForPerson: 0}, openId: ''};

const STATUS = {
  troubleshooting: ['Being helped', 'neutral'],
  raised: ['Raised', 'accent'],
  email_sent: ['Email sent', 'success'],
  email_failed: ['Email failed', 'danger'],
  human_requested: ['Person requested', 'accent'],
  callback_booked: ['Callback booked', 'accent'],
  resolved: ['Resolved', 'success'],
};
// what the email is doing, in words that never say "sent" unless it was
const EMAIL = {
  none: ['No email', 'neutral'],
  needs_email: ['Needs the customer’s email', 'warning'],
  sending: ['Sending', 'neutral'],
  sent: ['Email sent', 'success'],
  retrying: ['Not sent yet: trying again', 'warning'],
  failed: ['Email NOT sent', 'danger'],
  not_configured: ['Email NOT sent: no support email set', 'danger'],
  refused: ['Customer did not want an email', 'neutral'],
};
const HANDOFF = {
  none: ['', 'neutral'],
  requested: ['Waiting for a person', 'warning'],
  connected: ['Person on the call', 'success'],
  unavailable: ['No one was available', 'danger'],
  callback: ['Callback booked', 'accent'],
  ended: ['Call ended', 'neutral'],
};

const FILTERS = [['open', 'Open'], ['attention', 'Needs you'], ['resolved', 'Resolved'], ['all', 'All']];

screens.complaints = {
  async load() {
    const query = ui.filter === 'open' ? {open: 1} : ui.filter === 'resolved' ? {open: 0} : ui.filter === 'attention' ? {open: 1} : {};
    const res = await getComplaints({...query, limit: 100});
    ui.items = ui.filter === 'attention'
      ? res.items.filter((c) => ['failed', 'not_configured', 'retrying', 'needs_email'].includes(c.email.status) || ['requested', 'unavailable'].includes(c.handoff.status))
      : res.items;
    ui.counts = res.counts || ui.counts;
    return {};
  },
  html: () => page(),
};

async function redraw() {
  (await import('../app.js')).redraw();
}

const when = (iso) => (iso ? formatWhen(iso, state.store.timezone, Date.now()) : '');
const chip = (map, key) => { const [text, tone] = map[key] || [key, 'neutral']; return text ? pill(text, tone) : ''; };

function detail(c) {
  const row = (label, value) => (value ? `<div class="flex gap-3 text-xs"><div class="w-36 shrink-0 text-ink-muted">${esc(label)}</div><div class="min-w-0 text-ink-primary break-words">${value}</div></div>` : '');
  const attempts = c.attempts.length ? `<ul class="list-disc pl-4 space-y-0.5">${c.attempts.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : '';
  const emailLine = c.email.status === 'sent'
    ? `Sent ${esc(when(c.email.sentAt))} to ${esc(c.email.to)}, copy to ${esc(c.email.cc)}`
    : c.email.status === 'none' || c.email.status === 'refused' ? '' : esc(c.email.error || '');
  const canRetry = c.open && ['failed', 'not_configured'].includes(c.email.status);
  return `<div class="px-4 pb-4 pt-1 space-y-2 border-t border-line-subtle">
    ${row('The problem', esc(c.summary))}
    ${row('Customer’s own words', c.originalMessage ? `“${esc(c.originalMessage)}”` : '')}
    ${row('Customer', esc([c.customer.name, c.customer.email].filter(Boolean).join(' · ')))}
    ${row('Order', c.orderNumber ? `${esc(c.orderNumber)} <span class="text-ink-muted">${c.orderVerified ? '(checked against your store)' : '(as the customer said it, not verified)'}</span>` : '')}
    ${row('Product', esc(c.productName))}
    ${row('Already tried', attempts)}
    ${row('Customer’s reply', esc(c.customerResponse))}
    ${row('Why it was raised', esc(c.escalationReason))}
    ${row('Email', `${chip(EMAIL, c.email.status)} <span class="text-ink-secondary">${emailLine}</span>`)}
    ${row('Person / call', chip(HANDOFF, c.handoff.status) ? `${chip(HANDOFF, c.handoff.status)} <span class="text-ink-muted">${esc(when(c.handoff.at))}</span>` : '')}
    ${row('Reference', `<span class="font-mono">${esc(c.reference)}</span> · started ${esc(when(c.createdAt))}`)}
    <div class="flex flex-wrap gap-2 pt-1">
      ${c.conversationId ? `<button type="button" data-action="open-chat" data-id="${esc(c.conversationId)}" class="px-3 py-1.5 rounded-md text-xs font-medium border border-line-subtle hover:bg-subtle">Open the chat</button>` : ''}
      ${canRetry ? `<button type="button" data-action="complaint-retry" data-id="${esc(c.id)}" class="px-3 py-1.5 rounded-md text-xs font-semibold bg-accent-gradient text-white">Send the email again</button>` : ''}
      ${c.open ? `<button type="button" data-action="complaint-resolve" data-id="${esc(c.id)}" class="px-3 py-1.5 rounded-md text-xs font-medium border border-line-subtle hover:bg-subtle">Mark as resolved</button>` : ''}
    </div></div>`;
}

function card(c) {
  const [statusText, statusTone] = STATUS[c.status] || [c.status, 'neutral'];
  const opened = ui.openId === c.id;
  const emailBad = ['failed', 'not_configured', 'retrying', 'needs_email'].includes(c.email.status);
  return `<div class="rounded-lg border ${emailBad || ['unavailable'].includes(c.handoff.status) ? 'border-danger/50' : 'border-line-subtle'} bg-surface overflow-hidden">
    <button type="button" data-action="complaint-toggle" data-id="${esc(c.id)}" class="w-full text-left p-4 flex flex-wrap items-start justify-between gap-3 hover:bg-subtle/40">
      <div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><span class="text-sm font-semibold text-ink-primary">${esc(c.customer.name || c.customer.email || 'A customer')}</span>${pill(statusText, statusTone)}${c.email.status !== 'none' ? chip(EMAIL, c.email.status) : ''}${chip(HANDOFF, c.handoff.status)}</div>
        <div class="text-xs text-ink-secondary mt-1 line-clamp-2">${esc(c.summary || c.originalMessage || 'No description yet')}</div>
        <div class="text-[11px] text-ink-muted mt-1"><span class="font-mono">${esc(c.reference)}</span>${c.orderNumber ? ` · order ${esc(c.orderNumber)}` : ''} · ${esc(when(c.createdAt))}</div></div>
    </button>${opened ? detail(c) : ''}</div>`;
}

function page() {
  const tabs = FILTERS.map(([id, label]) => `<button type="button" data-action="complaint-filter" data-id="${id}" class="px-3 py-1.5 rounded-md text-xs font-medium ${ui.filter === id ? 'bg-accent-soft text-accent-text' : 'text-ink-secondary hover:bg-subtle'}">${label}${id === 'open' ? ` (${ui.counts.open})` : ''}</button>`).join('');
  const warn = ui.counts.emailFailed ? `<div class="p-3 rounded-lg bg-danger-soft text-danger-text text-xs" role="alert"><span class="font-semibold">${ui.counts.emailFailed} complaint${ui.counts.emailFailed === 1 ? '' : 's'} could not be emailed to you.</span> They are saved here: open one and use “Send the email again” once your support email and email sending are set up.</div>` : '';
  return `<div class="space-y-4"><div><h1 class="type-h1">Complaints</h1><p class="type-body text-ink-secondary">Problems customers raised in the chat, with what they said and what was already tried. An email is only shown as sent when it really was.</p></div>
    ${warn}<div class="flex flex-wrap gap-1.5">${tabs}</div>
    ${ui.items.length ? `<div class="space-y-2.5">${ui.items.map(card).join('')}</div>` : emptyState('No complaints here', ui.filter === 'resolved' ? 'Settled complaints show up here.' : 'When a customer raises a complaint in the chat, it shows up here.', 'flag')}</div>`;
}

actions['complaint-filter'] = async (el) => {
  ui.filter = el.getAttribute('data-id');
  ui.openId = '';
  await redraw();
};
actions['complaint-toggle'] = async (el) => {
  const id = el.getAttribute('data-id');
  ui.openId = ui.openId === id ? '' : id;
  await redraw();
};
actions['complaint-retry'] = async (el) => {
  el.disabled = true;
  const out = await retryComplaintEmail(el.getAttribute('data-id'));
  if (out.status === 'ok') toast('Email sent', 'The store and the customer have it.');
  else if (out.status === 'already_raised') toast('Already sent', 'This complaint was already emailed.', 'warning');
  else toast('The email still could not be sent', out.complaint?.email?.error || 'Check the support email in Settings and the email setup on the server.', 'danger');
  await redraw();
};
actions['complaint-resolve'] = async (el) => {
  await resolveComplaint(el.getAttribute('data-id'));
  toast('Marked as resolved', '');
  ui.openId = '';
  await redraw();
};
