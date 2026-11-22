// Bookings: calls shoppers asked for in the chat. Confirm one (the shopper and your calendar are told), suggest another
// free time, or close it as done, missed or cancelled.
import {actions, screens, state} from '../core.js';
import {closeBooking, confirmBooking, getAttention, getBookingSlots, getBookings, rescheduleBooking} from '../api.js';
import {CALL_FILTERS, callDoneText, callView, slotChoices} from '../lib/bookings.js';
import {closeModal, emptyState, esc, openModal, pill, toast} from '../ui.js';

const TONE = {success: 'success', caution: 'warning', critical: 'danger', neutral: 'neutral'};
const ui = {status: 'requested', items: []};

screens.bookings = {
  async load() {
    const res = await getBookings(ui.status ? {status: ui.status} : {});
    ui.items = res.items;
    return {};
  },
  html: () => page(),
};

async function redraw() {
  const {redraw: draw} = await import('../app.js');
  draw();
}

function card(b) {
  const v = callView(b);
  const btn = (a) => `<button type="button" data-action="call-${a.id}" data-id="${esc(v.id)}" class="px-3 py-1.5 rounded-sm text-xs font-medium ${a.primary ? 'bg-success text-white' : a.tone === 'critical' ? 'border border-danger text-danger-text hover:bg-danger-soft' : 'border border-line-subtle hover:bg-subtle'}">${esc(a.label)}</button>`;
  return `<div class="p-4 flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><span class="text-sm font-semibold text-ink-primary">${esc(v.who)}</span>${pill(v.status, TONE[v.tone] || 'neutral')}${v.overdue ? pill('Time has passed', 'danger') : ''}</div>
      <div class="text-xs text-ink-secondary mt-1">${esc(v.span || v.when)}${v.language ? ` · ${esc(v.language)}` : ''}</div>
      ${v.topic ? `<div class="text-xs text-ink-primary mt-1">${esc(v.topic)}</div>` : ''}
      ${v.contact ? `<div class="text-[11px] text-ink-muted mt-1">${esc(v.contact)}</div>` : ''}
      <div class="text-[11px] mt-1 ${v.calendar.tone === 'critical' ? 'text-danger-text' : 'text-ink-muted'}">${esc(v.calendar.text)}${v.calendar.link ? ` · <a class="text-accent underline" href="${esc(v.calendar.link)}" target="_blank" rel="noopener noreferrer">Open</a>` : ''}</div>
      <div class="text-[11px] ${v.email.tone === 'critical' ? 'text-danger-text' : 'text-ink-muted'}">${esc(v.email.text)}</div>
      ${v.chatId ? `<button type="button" data-action="open-chat" data-id="${esc(v.chatId)}" class="mt-1 text-[11px] text-accent hover:underline">Open the chat</button>` : ''}</div>
    <div class="flex flex-wrap items-center gap-2">${v.actions.map(btn).join('')}</div></div>`;
}

function page() {
  return `<div class="space-y-4"><div><h1 class="type-h1">Bookings &amp; calls</h1><p class="type-body text-ink-secondary">Calls shoppers asked for in the chat. Times are shown in the time zone each call was booked in.</p></div>
    <div class="flex flex-wrap gap-1.5">${CALL_FILTERS.map((f) => `<button type="button" data-action="call-filter" data-status="${f.id}" class="px-3 py-1.5 rounded-pill text-xs font-medium border ${ui.status === f.id ? 'bg-accent-soft text-accent-text border-accent' : 'border-line-subtle text-ink-secondary hover:bg-subtle'}">${f.label}</button>`).join('')}</div>
    <div class="rounded-lg border border-line-subtle bg-surface divide-y divide-line-subtle shadow-xs">${ui.items.length ? ui.items.map(card).join('') : emptyState('No calls here', ui.status === 'requested' ? 'Nobody is waiting for a call.' : 'Nothing in this list yet.', 'calendar')}</div></div>`;
}

async function refresh(message) {
  const res = await getBookings(ui.status ? {status: ui.status} : {});
  ui.items = res.items;
  state.attention = await getAttention().catch(() => state.attention);
  const app = await import('../app.js');
  app.redraw();
  toast(message);
}

actions['call-filter'] = async (el) => {
  ui.status = el.getAttribute('data-status') || '';
  ui.items = (await getBookings(ui.status ? {status: ui.status} : {})).items;
  await redraw();
};
for (const id of ['confirm', 'retry']) {
  actions[`call-${id}`] = async (el) => {
    await confirmBooking(el.getAttribute('data-id'));
    await refresh(callDoneText(id));
  };
}
for (const id of ['completed', 'missed', 'cancelled']) {
  actions[`call-${id}`] = async (el) => {
    await closeBooking(el.getAttribute('data-id'), id);
    await refresh(callDoneText(id));
  };
}
actions['call-change'] = async (el) => {
  const id = el.getAttribute('data-id');
  const {slots} = await getBookingSlots();
  const choices = slotChoices(slots);
  if (!choices.length) return toast('No free times', 'Add working hours in Settings, then try again.', 'warning');
  openModal('Suggest another time', `<label class="text-xs">Free times<select id="slot-pick" class="mt-1 w-full px-2 py-2 rounded-md border border-line-subtle bg-surface">${choices.map((c) => `<option value="${esc(c.value)}">${esc(c.label)}</option>`).join('')}</select></label>`,
    `<button type="button" data-action="close-modal" class="px-3 py-2 rounded-md text-xs font-medium border border-line-subtle hover:bg-subtle">Cancel</button><button type="button" data-action="call-move" data-id="${esc(id)}" class="px-3 py-2 rounded-md text-xs font-medium bg-accent-gradient text-white">Move the call</button>`);
};
actions['call-move'] = async (el) => {
  await rescheduleBooking(el.getAttribute('data-id'), document.getElementById('slot-pick').value);
  closeModal();
  await refresh(callDoneText('change'));
};
actions['close-modal'] = () => closeModal();
