// Conversations: the inbox on the left, the chat in the middle, and the controls (take over, hand back, resolve,
// note, refund or exchange request) on the right. Messages are the real transcript the shopper and AI had.
import {actions, screens, state, wideRange} from '../core.js';
import {ApiError, getAttachment, markChatRead, getConversation, getConversations, sendReply, setCase, setConversationNote, setConversationStatus, setHandoff} from '../api.js';
import {CASE_STATUSES, CASE_TYPES, caseChanged, caseDraft, caseTitle, chatRow, personLabel, replyBox, transcriptLines} from '../lib/chats.js';
import {shownView} from '../lib/bookings.js';
import {formatWhen} from '../lib/format.js';
import {debounce, emptyState, esc, pill, productCard, toast} from '../ui.js';
import {sup} from '../support.js';
import {dayKey, dayLabel, formatWhen as when} from '../lib/format.js';

const TONE = {success: 'success', caution: 'warning', info: 'accent', call: 'accent', neutral: 'neutral', critical: 'danger'};
const TABS = [
  {id: '', label: 'All', key: 'all'},
  {id: 'ai', label: 'AI handling', key: 'ai'},
  {id: 'human', label: 'Human requested', key: 'human'},
  {id: 'human_waiting', label: 'Waiting for human', key: 'human_waiting'},
  {id: 'human_live', label: 'Human connected', key: 'human_live'},
  {id: 'calls', label: 'Callback scheduled', key: 'calls'},
  {id: 'waiting', label: 'Waiting on you', key: 'waiting'},
  {id: 'person', label: 'With a person', key: 'person'},
  {id: 'files', label: 'Files', key: 'files'},
  {id: 'resolved', label: 'Resolved', key: 'resolved'},
];
/** a live-help request or call on a chat row, in words */
const SUPPORT_PILL = {requested: ['Waiting for human', 'danger'], accepted: ['Connecting call', 'accent'], connected: ['On a call', 'accent'], unanswered: ['Call missed', 'warning'], failed: ['Call failed', 'warning'], ended: ['Call done', 'success'], cancelled: ['Call cancelled', 'neutral']};
const supportPill = (s) => (s && SUPPORT_PILL[s.status] ? pill(...SUPPORT_PILL[s.status]) : '');

/** the inbox on screen: what is listed, which chat is open */
const ui = {filter: '', q: '', items: [], next: null, total: 0, selected: '', detail: null, loadingDetail: false, caseDraft: null, zoom: '', readId: ''};

async function loadList({append = false} = {}) {
  // a chip such as "Waiting on you" looks at every chat, whatever its date; "All" looks back a year
  const query = {...(ui.filter ? {} : wideRange()), limit: 25, filter: ui.filter || undefined, q: ui.q || undefined, cursor: append ? ui.next : undefined};
  const page = await getConversations(query);
  ui.items = append ? [...ui.items, ...page.items] : page.items;
  ui.next = page.nextCursor;
  if (page.total !== undefined) ui.total = page.total;
}

async function loadDetail(id) {
  ui.selected = id;
  ui.loadingDetail = true;
  ui.detail = null;
  try {
    ui.detail = await getConversation(id);
    ui.caseDraft = caseDraft(ui.detail.conversation.case);
    // a chat the owner chose to open is read: the row loses its bold dot and the sidebar number drops.
    // The chat that only opens by itself when the screen loads (the first row) stays unread.
    const row = ui.items.find((i) => i.id === id);
    if (row?.unread && ui.readId === id) {
      row.unread = false;
      markChatRead(id).then(refreshCounts).then(async () => (await import('../app.js')).renderNav()).catch(() => {});
    }
  } finally {
    ui.loadingDetail = false;
  }
}

screens.conversations = {
  async load() {
    if (state.openFilter) {
      ui.filter = state.openFilter;
      ui.q = '';
      ui.selected = '';
      state.openFilter = '';
    }
    if (state.openConv) {
      ui.filter = '';
      ui.q = '';
    }
    await loadList();
    const wanted = state.openConv || ui.selected || ui.items[0]?.id;
    if (state.openConv) ui.readId = state.openConv;
    state.openConv = '';
    if (wanted) await loadDetail(wanted).catch(() => { ui.detail = null; });
    return {};
  },
  html: () => page(),
  after() {
    const box = document.getElementById('chat-thread-messages');
    if (box) box.scrollTop = box.scrollHeight;
  },
};

async function redraw() {
  const {redraw: draw} = await import('../app.js');
  draw();
}

const zoomBtn = (col) => `<button type="button" data-action="zoom-col" data-col="${col}" title="${ui.zoom === col ? 'Back to 3 columns' : 'Zoom this column'}" aria-label="${ui.zoom === col ? 'Back to 3 columns' : 'Zoom this column'}" class="hidden lg:inline-flex p-1 rounded-md text-ink-muted hover:bg-subtle hover:text-ink-primary shrink-0"><i data-lucide="${ui.zoom === col ? 'minimize-2' : 'maximize-2'}" class="w-3.5 h-3.5"></i></button>`;
/** the width of a column: normal, full when zoomed, gone when another column is zoomed */
const span = (col, n) => (!ui.zoom ? {3: 'lg:col-span-3', 4: 'lg:col-span-4', 5: 'lg:col-span-5'}[n] : ui.zoom === col ? 'lg:col-span-12' : 'hidden');

function counts() {
  const i = state.attention?.inbox || {};
  return i;
}

function list() {
  const c = counts();
  return `<div class="${span('list', 4)} border-b lg:border-b-0 lg:border-r border-line-subtle flex flex-col">
    <div class="p-3 border-b border-line-subtle space-y-2">
      <div class="flex items-center gap-2"><div class="relative flex-1"><i data-lucide="search" class="w-3.5 h-3.5 text-ink-muted absolute left-2.5 top-2.5"></i>
        <input id="conv-search-input" type="search" value="${esc(ui.q)}" placeholder="Search name, email, phone or message" aria-label="Search chats" class="w-full pl-8 pr-3 py-1.5 text-xs rounded-sm border border-line-subtle bg-subtle/40 focus-ring" /></div>${zoomBtn('list')}</div>
      <div class="flex items-center gap-1 overflow-x-auto">${TABS.map((t) => `<button type="button" data-action="conv-tab" data-tab="${t.id}" class="px-2 py-1 rounded-sm text-[11px] font-medium whitespace-nowrap ${ui.filter === t.id ? 'bg-accent-soft text-accent-text font-semibold' : 'text-ink-secondary hover:bg-subtle'}">${t.label}${c[t.key] != null ? ` <span class="tabular-nums">(${c[t.key]})</span>` : ''}</button>`).join('')}</div>
    </div>
    <div class="divide-y divide-line-subtle flex-1 overflow-y-auto max-h-[640px]">
      ${ui.items.length ? ui.items.map((chat) => {
        const r = chatRow(chat, {timezone: state.store.timezone});
        const on = ui.selected === chat.id;
        const dot = {waiting: 'bg-danger', person: 'bg-accent', ai: 'bg-accent', resolved: 'bg-slate-400'}[r.state.id] || 'bg-slate-400';
        return `<button type="button" data-action="select-chat" data-id="${esc(chat.id)}" class="w-full p-3 text-left transition-colors flex items-start justify-between gap-2 ${on ? 'bg-accent-soft/50 border-l-2 border-l-accent' : 'hover:bg-subtle/60'}">
          <div class="min-w-0 flex-1"><div class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-full ${dot} shrink-0"></span><span class="text-xs ${chat.unread ? 'font-bold' : 'font-semibold'} text-ink-primary truncate">${esc(r.who)}</span>${chat.unread ? '<span class="px-1.5 py-px rounded-pill bg-accent text-white text-[9px] font-semibold">New</span>' : ''}${r.kind ? `<span class="text-[11px] text-ink-muted truncate">${esc(r.kind)}</span>` : ''}</div>
          <p class="text-xs text-ink-secondary truncate mt-1">${esc(r.preview)}</p>
          <div class="flex flex-wrap items-center gap-1.5 mt-1.5">${supportPill(chat.support)}${pill(r.state.label, TONE[r.state.tone] || 'neutral')}${r.tags.filter((t) => t.id !== 'person').slice(0, 2).map((t) => pill(t.text, TONE[t.tone] || 'neutral')).join('')}${r.request ? pill(r.request.text, TONE[r.request.tone] || 'neutral') : ''}</div></div>
          <div class="text-right shrink-0 tabular-nums"><div class="text-[11px] text-ink-muted">${esc(r.when)}</div><div class="text-[10px] text-ink-muted mt-1">${esc(r.result)}</div>${chat.chatCount > 1 ? `<div class="text-[10px] text-ink-muted">${chat.chatCount} chats</div>` : ''}</div></button>`;
      }).join('') : `<div class="p-6">${emptyState('No chats here', ui.q ? 'Nothing matches that search.' : 'New chats show up here.', 'message-square')}</div>`}
      ${ui.next ? '<div class="p-3 text-center"><button type="button" data-action="more-chats" class="px-3 py-1.5 rounded-md text-xs font-medium border border-line-subtle hover:bg-subtle">Show more</button></div>' : ''}
    </div></div>`;
}

function mmss(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
const CALL_TONE = {ended: 'success', connected: 'accent', accepted: 'accent', requested: 'danger', unanswered: 'warning', failed: 'warning', cancelled: 'neutral'};
const CALL_LABEL = {ended: 'Completed', connected: 'On a call', accepted: 'Connecting', requested: 'Waiting', unanswered: 'Not answered', failed: 'Could not connect', cancelled: 'Cancelled'};

/** The line a finished call leaves in the transcript, with its recording when there is one. */
function callLine(line) {
  const c = line.call;
  const rec = c.recording ? `<div class="mt-1.5" data-rec-box="${esc(c.callId)}"><button type="button" data-action="play-recording" data-id="${esc(c.callId)}" class="px-2.5 py-1 rounded-md text-[11px] font-medium border border-line-subtle bg-surface hover:bg-subtle inline-flex items-center gap-1"><i data-lucide="play" class="w-3 h-3"></i>Play recording</button></div>` : '';
  return `<div class="flex justify-center"><div class="max-w-[92%] px-3 py-2 rounded-lg bg-accent-soft/60 border border-line-subtle text-xs"><div class="flex items-center gap-1.5 font-medium text-ink-primary"><i data-lucide="phone" class="w-3.5 h-3.5 text-accent"></i>${esc(line.text)}</div><div class="text-[10px] text-ink-muted mt-0.5">${esc(line.when)}</div>${rec}</div></div>`;
}

/** The whole thread of this person, with a small date label whenever the day changes. */
function withDays(lines) {
  let last = '';
  return lines.map((line) => {
    const key = dayKey(line.at, state.store.timezone);
    const mark = key && key !== last ? `<div class="flex justify-center my-1"><span class="px-2.5 py-0.5 rounded-pill bg-subtle border border-line-subtle text-[10px] text-ink-secondary">${esc(dayLabel(line.at, state.store.timezone))}</span></div>` : '';
    last = key || last;
    return mark + bubble(line);
  }).join('');
}

function bubble(line) {
  if (line.call) return callLine(line);
  const {products, steps} = shownView(line.shown, {timezone: state.store.timezone, currency: state.store.currency});
  const files = line.attachments.map((f) => `<button type="button" data-action="open-file" data-id="${esc(f.id)}" data-name="${esc(f.name)}" class="mt-2 flex items-center gap-1.5 text-[11px] underline"><i data-lucide="paperclip" class="w-3 h-3"></i>${esc(f.name)} · ${esc(f.size)}</button>`).join('');
  const extras = `${products.map((p) => productCard({title: p.title, image: p.image, price: p.price, compareAtPrice: '', currency: '', inStock: !p.outOfStock})).join('')}${steps.map((s) => `<div class="mt-2 flex justify-center"><span class="px-2.5 py-0.5 rounded-pill bg-subtle border border-line-subtle text-[11px] text-ink-secondary">${esc(s.text)}</span></div>`).join('')}`;
  if (line.fromCustomer) {
    return `<div class="flex flex-col items-end"><div class="max-w-[85%] rounded-lg px-3.5 py-2.5 bg-slate-800 dark:bg-slate-700 text-white text-xs leading-relaxed shadow-xs whitespace-pre-wrap break-words">${esc(line.text)}${files}</div><span class="text-[10px] text-ink-muted mt-1 tabular-nums">Shopper • ${esc(line.when)}</span></div>`;
  }
  if (line.fromTeam) {
    return `<div class="flex flex-col items-start"><div class="max-w-[85%] rounded-lg px-3.5 py-2.5 bg-emerald-600 text-white text-xs leading-relaxed shadow-xs whitespace-pre-wrap break-words"><div class="text-[10px] font-semibold uppercase tracking-wider opacity-85 mb-0.5">Your team</div>${esc(line.text)}</div><span class="text-[10px] text-ink-muted mt-1 tabular-nums">Sent by your team • ${esc(line.when)}</span></div>`;
  }
  return `<div class="flex flex-col items-start"><div class="max-w-[88%] rounded-lg px-3.5 py-2.5 bg-surface border border-line-subtle text-ink-primary text-xs leading-relaxed shadow-xs"><span class="inline-flex items-center gap-1 text-[10px] font-semibold text-accent mb-1"><i data-lucide="sparkles" class="w-3 h-3"></i>AI assistant</span>${line.failed ? '<div class="mb-1">' + pill('Could not answer', 'danger') + '</div>' : ''}<div class="whitespace-pre-wrap break-words">${esc(line.text)}</div>${extras}</div><span class="text-[10px] text-ink-muted mt-1 tabular-nums">AI • ${esc(line.when)}</span></div>`;
}

function thread() {
  if (ui.loadingDetail) return `<div class="${span('thread', 5)} p-6 text-xs text-ink-muted">Loading chat…</div>`;
  if (!ui.detail) return `<div class="${span('thread', 5)} p-6">${emptyState('Pick a chat', 'Choose a conversation on the left to read it.', 'message-square')}</div>`;
  const {conversation: c, messages} = ui.detail;
  const r = chatRow(c, {timezone: state.store.timezone});
  const box = replyBox(c);
  const lines = transcriptLines(messages, {timezone: state.store.timezone});
  return `<div class="${span('thread', 5)} flex flex-col border-b lg:border-b-0 lg:border-r border-line-subtle">
    <div class="p-3 border-b border-line-subtle flex items-center justify-between bg-subtle/30"><div><div class="flex items-center gap-2"><span class="text-sm font-semibold">${esc(r.who)}</span>${r.kind ? pill(r.kind, r.kind === 'Signed in' ? 'success' : 'accent') : ''}${pill(r.state.label, TONE[r.state.tone] || 'neutral')}</div><div class="text-[11px] text-ink-muted">${esc([r.detail, r.channel, `${r.messages} messages`, c.chatCount > 1 ? `${c.chatCount} chats in one thread` : ''].filter(Boolean).join(' • '))}</div></div>${zoomBtn('thread')}</div>
    <div class="flex-1 p-4 space-y-3 overflow-y-auto bg-canvas/40 max-h-[430px]" id="chat-thread-messages">${lines.length ? withDays(lines) : emptyState('No messages saved', c.clearedByCustomer ? 'The shopper cleared this chat.' : '', 'message-square')}</div>
    <div class="p-3 border-t border-line-subtle bg-surface space-y-2">
      <p class="text-[11px] text-ink-muted">${esc(box.hint)}</p>
      <form id="conv-reply-form" class="flex items-center gap-2" data-id="${esc(c.id)}">
        <input id="conv-reply-input" type="text" maxlength="1000" ${box.canReply ? '' : 'disabled'} placeholder="${box.canReply ? `Reply to ${esc(r.who)} (takes over from the AI)` : 'Replies are turned off for this chat'}" aria-label="Reply" class="flex-1 px-3 py-2 text-xs rounded-md border border-line-subtle bg-subtle/40 focus-ring" />
        <button type="submit" ${box.canReply ? '' : 'disabled'} class="px-3.5 py-2 rounded-md text-xs font-medium bg-accent-gradient text-white shadow-xs flex items-center gap-1.5 disabled:opacity-50"><span>Send</span><i data-lucide="send" class="w-3.5 h-3.5"></i></button>
      </form>
    </div></div>`;
}

function side() {
  if (!ui.detail) return `<div class="${span('side', 3)} p-4 bg-subtle/20"></div>`;
  const {conversation: c, bookings} = ui.detail;
  const r = chatRow(c, {timezone: state.store.timezone});
  const resolved = c.status === 'resolved';
  const btn = 'handover-btn w-full py-2 px-3 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5';
  const draft = ui.caseDraft || caseDraft(c.case);
  const calls = ui.detail.calls || [];
  const waiting = calls.find((x) => x.status === 'requested');
  const live = calls.find((x) => ['accepted', 'connected'].includes(x.status));
  const wantsNow = waiting ? `<div class="p-3 rounded-md border border-danger bg-danger-soft/40 space-y-2"><div class="text-xs font-semibold text-danger-text">${esc(personLabel(c.contact, c.verifiedCustomer))} wants to talk now</div>${waiting.reason ? `<div class="text-[11px] text-ink-secondary">“${esc(waiting.reason)}”</div>` : ''}<div class="text-[11px] text-ink-muted">${waiting.recording.consent ? 'The shopper agreed to a recording.' : 'No recording.'}</div>${sup.presence === 'online' && !sup.active ? `<div class="flex gap-2"><button type="button" data-action="support-accept" data-id="${esc(waiting.id)}" class="flex-1 py-1.5 rounded-md text-xs font-semibold bg-success text-white">Accept call</button><button type="button" data-action="support-reject" data-id="${esc(waiting.id)}" class="flex-1 py-1.5 rounded-md text-xs border border-line-subtle bg-surface">Reject</button></div>` : '<div class="text-[11px] text-ink-secondary">Set yourself Online (top right) to take it.</div>'}</div>` : '';
  const liveCard = live ? `<div class="p-3 rounded-md border border-line-subtle bg-accent-soft/40 text-xs"><div class="font-semibold text-accent-text">${live.status === 'connected' ? 'On a call' : 'Connecting a call'}</div><div class="text-ink-secondary mt-0.5">With ${esc(live.representative?.name || 'a team member')}</div></div>` : '';
  const history = calls.length ? `<div class="p-3 rounded-md border border-line-subtle bg-surface space-y-2"><div class="text-xs font-semibold">Call history</div>${calls.map((x) => `<div class="text-[11px] pt-1.5 border-t border-line-subtle first:border-0 first:pt-0"><div class="flex items-center justify-between gap-2"><span class="text-ink-primary">${esc(when(x.requestedAt, state.store.timezone))}</span>${pill(CALL_LABEL[x.status] || x.status, CALL_TONE[x.status] || 'neutral')}</div><div class="text-ink-muted mt-0.5">${esc([x.representative?.name ? `With ${x.representative.name}` : '', x.status === 'ended' ? `Duration ${mmss(x.durationSec)}` : '', x.recording.consent ? 'Recording agreed' : 'No recording', x.recording.status === 'failed' ? 'Recording not saved' : '', x.failureReason].filter(Boolean).join(' · '))}</div>${x.recording.available ? `<div class="mt-1" data-rec-box="${esc(x.id)}"><button type="button" data-action="play-recording" data-id="${esc(x.id)}" class="px-2 py-1 rounded-md text-[11px] font-medium border border-line-subtle hover:bg-subtle inline-flex items-center gap-1"><i data-lucide="play" class="w-3 h-3"></i>Play recording</button></div>` : ''}</div>`).join('')}</div>` : '';
  return `<div class="${span('side', 3)} p-4 space-y-4 bg-subtle/20 overflow-y-auto max-h-[760px]">
    <div class="hidden lg:flex justify-end -mb-2">${zoomBtn('side')}</div>
    ${wantsNow}${liveCard}
    <div class="space-y-1.5"><div class="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Chat control</div><div class="grid grid-cols-1 gap-1.5">
      ${c.handoff?.active
        ? `<button type="button" data-action="hand-back" data-id="${esc(c.id)}" class="${btn} bg-accent-gradient text-white shadow-xs"><i data-lucide="sparkles" class="w-3.5 h-3.5"></i>Hand back to AI</button>`
        : `<button type="button" data-action="take-over" data-id="${esc(c.id)}" class="${btn} bg-accent-gradient text-white shadow-xs"><i data-lucide="user-check" class="w-3.5 h-3.5"></i>Take over from AI</button>`}
      ${resolved
        ? `<button type="button" data-action="set-status" data-status="open" data-id="${esc(c.id)}" class="${btn} border border-line-subtle bg-surface hover:bg-subtle text-ink-secondary"><i data-lucide="rotate-ccw" class="w-3.5 h-3.5"></i>Reopen</button>`
        : `<button type="button" data-action="set-status" data-status="resolved" data-id="${esc(c.id)}" class="${btn} border border-line-subtle bg-surface hover:bg-subtle text-ink-secondary"><i data-lucide="check-circle" class="w-3.5 h-3.5"></i>Mark as resolved</button>`}
      ${!resolved && c.status !== 'needs_human' ? `<button type="button" data-action="set-status" data-status="needs_human" data-id="${esc(c.id)}" class="${btn} border border-line-subtle bg-surface hover:bg-subtle text-ink-secondary"><i data-lucide="flag" class="w-3.5 h-3.5"></i>Mark for follow-up</button>` : ''}
    </div></div>
    <div class="p-3 rounded-md border border-line-subtle bg-surface space-y-1.5"><div class="text-xs font-semibold">${esc(personLabel(c.contact, c.verifiedCustomer))}</div>
      ${c.contact?.email ? `<div class="text-[11px] text-ink-secondary break-all">${esc(c.contact.email)}</div>` : ''}${c.contact?.phone ? `<div class="text-[11px] text-ink-secondary">${esc(c.contact.phone)}</div>` : ''}
      <div class="pt-1.5 mt-1.5 border-t border-line-subtle text-[11px] text-ink-muted">${esc(r.kind || 'Visitor')} • started ${esc(r.started)}${c.language ? ` • ${esc(c.language)}` : ''}</div>
      <div class="flex flex-wrap gap-1 pt-1">${pill(r.result, TONE[r.resultTone] || 'neutral')}${r.tags.map((t) => pill(t.text, TONE[t.tone] || 'neutral')).join('')}</div>
      ${c.flags?.reason ? `<div class="text-[11px] text-ink-secondary pt-1">Why: ${esc(c.flags.reason)}</div>` : ''}</div>
    ${history}
    ${bookings?.length ? `<div class="p-3 rounded-md border border-line-subtle bg-surface space-y-1"><div class="text-xs font-semibold">Callback booked</div>${bookings.map((b) => `<div class="text-[11px] text-ink-secondary">${esc(formatWhen(b.startAt, b.timezone || state.store.timezone))} · ${esc(b.status)}</div>`).join('')}<button type="button" data-nav="bookings" class="text-[11px] text-accent hover:underline">Open bookings</button></div>` : ''}
    <div class="p-3 rounded-md border border-line-subtle bg-surface space-y-2"><div class="text-xs font-semibold">${esc(caseTitle(c.case))}</div>
      <div class="grid grid-cols-2 gap-1.5"><select id="case-type" aria-label="Request type" class="px-2 py-1.5 text-xs rounded border border-line-subtle bg-subtle/40">${CASE_TYPES.map((t) => `<option value="${t.id}" ${draft.type === t.id ? 'selected' : ''}>${t.label}</option>`).join('')}</select>
        <select id="case-status" aria-label="Request status" class="px-2 py-1.5 text-xs rounded border border-line-subtle bg-subtle/40">${CASE_STATUSES.map((t) => `<option value="${t.id}" ${draft.status === t.id ? 'selected' : ''}>${t.label}</option>`).join('')}</select></div>
      <textarea id="case-note" rows="2" maxlength="500" aria-label="Request note" class="w-full p-2 text-xs rounded border border-line-subtle bg-subtle/40" placeholder="What was agreed with the shopper">${esc(draft.note)}</textarea>
      <button type="button" data-action="save-case" data-id="${esc(c.id)}" class="w-full py-1 rounded text-[11px] font-medium border border-line-subtle hover:bg-subtle">${c.case ? 'Update request' : 'Track a refund or exchange'}</button></div>
    <div class="p-3 rounded-md border border-line-subtle bg-surface space-y-2"><div class="text-xs font-semibold">Private note</div>
      <textarea id="conv-note-textarea" rows="2" maxlength="1000" aria-label="Private note" class="w-full p-2 text-xs rounded border border-line-subtle bg-subtle/40" placeholder="Only your team sees this">${esc(c.note || '')}</textarea>
      <button type="button" data-action="save-note" data-id="${esc(c.id)}" class="w-full py-1 rounded text-[11px] font-medium border border-line-subtle hover:bg-subtle">Save note</button></div>
  </div>`;
}

function page() {
  return `<div class="space-y-3"><div><h1 class="type-h1">Conversations</h1><p class="type-body text-ink-secondary">Real shopper chats. Take over any time, and hand it back when you are done.</p></div>
    <div class="grid grid-cols-1 lg:grid-cols-12 rounded-lg border border-line-subtle bg-surface shadow-xs overflow-hidden min-h-[640px]">${list()}${thread()}${side()}</div></div>`;
}

// ---- actions ------------------------------------------------------------------------------------------
async function refreshCounts() {
  const {getAttention} = await import('../api.js');
  state.attention = await getAttention().catch(() => state.attention);
}

actions['select-chat'] = async (el) => {
  ui.readId = el.getAttribute('data-id');
  await loadDetail(el.getAttribute('data-id')).catch((e) => toast('Could not open the chat', e instanceof ApiError ? e.message : '', 'danger'));
  await redraw();
};
actions['conv-tab'] = async (el) => {
  ui.filter = el.getAttribute('data-tab') || '';
  await loadList();
  const keep = ui.items.find((i) => i.id === ui.selected)?.id || ui.items[0]?.id;
  if (keep) await loadDetail(keep).catch(() => {}); else ui.detail = null;
  await redraw();
};
actions['zoom-col'] = async (el) => {
  const col = el.getAttribute('data-col');
  ui.zoom = ui.zoom === col ? '' : col;
  await redraw();
};
actions['more-chats'] = async () => {
  await loadList({append: true});
  await redraw();
};

async function afterChange(id, message) {
  ui.readId = id; // acting on a chat means it was read
  await Promise.all([loadList().catch(() => {}), loadDetail(id), refreshCounts()]);
  await redraw();
  toast(message);
}
actions['take-over'] = async (el) => {
  const id = el.getAttribute('data-id');
  await setHandoff(id, true);
  await afterChange(id, 'You have this chat. The AI stays quiet.');
};
actions['hand-back'] = async (el) => {
  const id = el.getAttribute('data-id');
  await setHandoff(id, false);
  await afterChange(id, 'Handed back to the AI.');
};
actions['set-status'] = async (el) => {
  const id = el.getAttribute('data-id');
  const status = el.getAttribute('data-status');
  await setConversationStatus(id, status);
  await afterChange(id, status === 'resolved' ? 'Marked as resolved.' : status === 'open' ? 'Chat reopened.' : 'Marked for follow-up.');
};
actions['save-note'] = async (el) => {
  const id = el.getAttribute('data-id');
  await setConversationNote(id, document.getElementById('conv-note-textarea').value);
  await afterChange(id, 'Note saved.');
};
actions['save-case'] = async (el) => {
  const id = el.getAttribute('data-id');
  const draft = {type: document.getElementById('case-type').value, status: document.getElementById('case-status').value, note: document.getElementById('case-note').value.trim()};
  if (!caseChanged(ui.detail?.conversation?.case, draft)) return toast('Nothing to save', '', 'warning');
  await setCase(id, draft);
  await afterChange(id, 'Request saved.');
};
actions['open-file'] = async (el) => {
  const blob = await getAttachment(el.getAttribute('data-id'));
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.download = el.getAttribute('data-name') || 'file';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement) || form.id !== 'conv-reply-form') return;
  e.preventDefault();
  const input = document.getElementById('conv-reply-input');
  const text = input.value.trim();
  if (!text) return;
  input.disabled = true;
  try {
    await sendReply(form.getAttribute('data-id'), text);
    await afterChange(form.getAttribute('data-id'), 'Sent. You have this chat now.');
  } catch (error) {
    input.disabled = false;
    toast('Could not send', error instanceof ApiError ? error.message : 'Try again.', 'danger');
  }
});

document.addEventListener('input', debounce(async (e) => {
  if (!(e.target instanceof HTMLElement) || e.target.id !== 'conv-search-input') return;
  ui.q = e.target.value.trim();
  await loadList().catch(() => {});
  await redraw();
  const el = document.getElementById('conv-search-input');
  el?.focus();
  el?.setSelectionRange(el.value.length, el.value.length);
}, 350));

// a saved call, played through an authorised request: it has no public address
actions['play-recording'] = async (el) => {
  const id = el.getAttribute('data-id');
  const box = el.closest('[data-rec-box]');
  el.disabled = true;
  el.textContent = 'Loading...';
  try {
    const token = await globalThis.shopify.idToken();
    const res = await fetch(`/admin/api/support/calls/${encodeURIComponent(id)}/recording`, {headers: {Authorization: `Bearer ${token}`, 'ngrok-skip-browser-warning': 'true'}});
    if (!res.ok) throw new Error('missing');
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.className = 'w-full h-9';
    const url = URL.createObjectURL(await res.blob());
    audio.src = url;
    const save = document.createElement('a');
    save.href = url;
    save.download = `call-${id}.webm`;
    save.textContent = 'Download';
    save.className = 'inline-block mt-1 text-[11px] font-medium text-accent-text hover:underline';
    box.replaceChildren(audio, save);
    audio.play().catch(() => {});
  } catch {
    el.disabled = false;
    el.textContent = 'Play recording';
    toast('The recording is not available', '', 'warning');
  }
};

// a call coming in, taken or ended changes the lists: refresh them, but never while someone is typing
const refreshLive = debounce(async () => {
  if (state.screen !== 'conversations' || !ui.items.length) return;
  if (document.activeElement?.matches?.('input, textarea, select')) return;
  try {
    await loadList();
    if (ui.selected) await loadDetail(ui.selected);
    await redraw();
  } catch { /* the next change tries again */ }
}, 600);
sup.onChange.add(refreshLive);
