// Calls: every call a shopper asked for, who made it, whether a person or the AI had it, how it ended and how long it
// lasted. Overview (store-wide), Team (call by call per person) and a full log you can filter. From any call you can go
// to the customer, the person who took it and the chat, and back.
import {actions, screens, state} from '../core.js';
import {getCallAnalytics, getCallDetail, getCallLog} from '../api.js';
import {formatNumber, formatShortDay} from '../lib/format.js';
import {OUTCOME_FILTERS, callRow, callTimeline, duration, handlerLabel, totalsLine} from '../lib/calls.js';
import {closeDrawer, emptyState, esc, openDrawer, pill, sparkline, toast} from '../ui.js';

const ui = {tab: 'overview', data: null, log: {items: [], next: null, total: 0}, filter: {outcome: '', handler: '', person: '', handlerName: '', personName: ''}, range: null};

screens.calls = {
  async load({range}) {
    ui.range = range;
    ui.data = await getCallAnalytics({from: range.from, to: range.to});
    if (ui.tab === 'log') await fetchLog(false);
    return {};
  },
  html: () => page(),
};

async function redraw() {
  (await import('../app.js')).redraw();
}

async function fetchLog(append) {
  const f = ui.filter;
  const page = await getCallLog({from: ui.range?.from, to: ui.range?.to, outcome: f.outcome || undefined, handler: f.handler || undefined, person: f.person || undefined, limit: 25, cursor: append ? ui.log.next : undefined});
  ui.log = {items: append ? [...ui.log.items, ...page.items] : page.items, next: page.next, total: page.total ?? ui.log.total};
}

const tz = () => state.store.timezone;
const tile = (label, value, sub = '', tone = '') => `<div class="rounded-lg border border-line-subtle bg-surface p-4 shadow-xs"><div class="text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">${esc(label)}</div><div class="mt-1 text-2xl font-semibold tabular-nums ${tone}">${esc(value)}</div>${sub ? `<div class="text-[11px] text-ink-muted mt-0.5">${esc(sub)}</div>` : ''}</div>`;

function overview(d) {
  const h = d.human;
  const days = d.trend.map((t) => t.total);
  const recent = d.recent.map((c) => callRow(c, {timezone: tz()}));
  return `<div class="space-y-5">
    <p class="text-xs text-ink-secondary">${esc(totalsLine(h))} Counted from the real call records. A callback request is not a call.</p>
    ${d.coverage.complete ? '' : `<div class="p-3 rounded-lg bg-warning-soft text-warning-text text-xs" role="note">${esc(d.coverage.note)}${d.longTerm ? ` For the whole range, from those short records: ${esc(totalsLine(d.longTerm))}` : ''}</div>`}
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      ${tile('Calls asked for', formatNumber(h.total), 'People who asked for a person')}
      ${tile('Completed', formatNumber(h.completed), `Talk time ${duration(h.totalDurationSec)}, avg ${duration(h.avgDurationSec)}`, 'text-success-text')}
      ${tile('Missed', formatNumber(h.missed), 'Nobody answered in time', h.missed ? 'text-danger-text' : '')}
      ${tile('Failed', formatNumber(h.failed), 'The audio could not connect', h.failed ? 'text-danger-text' : '')}
      ${tile('Cancelled', formatNumber(h.cancelled), 'The customer gave up first')}
      ${tile('Waiting / live', `${formatNumber(h.pending)} / ${formatNumber(h.live)}`, 'Asked, not finished yet')}
      ${tile('AI voice sessions', formatNumber(d.ai.sessions), `${formatNumber(d.ai.handedToPerson)} passed to a person`)}
      ${tile('Support interactions', formatNumber(d.interactions), 'A session and the call it became count once')}
    </div>
    <div class="rounded-lg border border-line-subtle bg-surface p-4 shadow-xs"><div class="type-small font-semibold mb-2">Calls per day</div>${days.length > 1 ? sparkline(days, '#4F46E5', 'calls') : '<div class="text-xs text-ink-muted">Not enough days to draw a trend yet.</div>'}
      ${d.trend.length ? `<div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-muted">${d.trend.slice(-7).map((t) => `<span>${esc(formatShortDay(t.day))}: <b class="text-ink-primary">${t.total}</b></span>`).join('')}</div>` : ''}</div>
    <div class="grid lg:grid-cols-2 gap-4">
      <div class="rounded-lg border border-line-subtle bg-surface shadow-xs"><div class="p-3 border-b border-line-subtle type-small font-semibold">Top customers by calls</div>
        ${d.topCustomers.length ? d.topCustomers.map((c) => `<button type="button" data-action="open-customer" data-id="${esc(c.id)}" class="w-full text-left p-3 flex justify-between gap-2 border-b border-line-subtle last:border-0 hover:bg-subtle/50 text-xs"><span class="font-medium text-ink-primary truncate">${esc(c.name || 'Visitor')}</span><span class="tabular-nums text-ink-secondary">${c.calls} ${c.calls === 1 ? 'call' : 'calls'}</span></button>`).join('') : '<div class="p-3 text-xs text-ink-muted">No calls yet.</div>'}</div>
      <div class="rounded-lg border border-line-subtle bg-surface shadow-xs"><div class="p-3 border-b border-line-subtle type-small font-semibold">Recent calls</div>
        ${recent.length ? recent.map(rowButton).join('') : '<div class="p-3 text-xs text-ink-muted">No calls yet.</div>'}</div>
    </div></div>`;
}

const rowButton = (r) => `<button type="button" data-action="open-call" data-id="${esc(r.id)}" class="w-full text-left p-3 flex flex-wrap items-center justify-between gap-2 border-b border-line-subtle last:border-0 hover:bg-subtle/50">
  <div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><span class="text-xs font-semibold text-ink-primary">${esc(r.who)}</span>${pill(r.outcome, r.tone)}</div>
    <div class="text-[11px] text-ink-muted mt-0.5">${esc(r.when)} · ${esc(r.kind)} · handled by ${esc(r.handler)}${r.duration !== '—' ? ` · ${esc(r.duration)}` : ''}</div></div></button>`;

function team(d) {
  if (!d.employees.length) return emptyState('No calls taken yet', 'When someone on your team takes a call, their numbers show up here.', 'users');
  return `<div class="rounded-lg border border-line-subtle bg-surface shadow-xs overflow-x-auto"><table class="w-full text-left border-collapse"><thead><tr class="border-b border-line-subtle bg-subtle/60 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
    <th class="py-3 px-4">Team member</th><th class="py-3 px-4">Took</th><th class="py-3 px-4">Completed</th><th class="py-3 px-4">Failed</th><th class="py-3 px-4">Dropped before talking</th><th class="py-3 px-4">Talk time</th><th class="py-3 px-4">Average</th></tr></thead>
    <tbody class="divide-y divide-line-subtle text-xs">${d.employees.map((e) => `<tr data-action="handler-calls" data-id="${esc(e.id)}" data-name="${esc(e.name)}" tabindex="0" class="hover:bg-subtle/60 cursor-pointer">
      <td class="py-3 px-4 font-semibold text-ink-primary">${esc(e.name || 'Team member')}</td><td class="py-3 px-4 tabular-nums">${e.taken}</td><td class="py-3 px-4 tabular-nums">${e.completed}</td><td class="py-3 px-4 tabular-nums">${e.failed}</td><td class="py-3 px-4 tabular-nums">${e.droppedBeforeTalking}</td><td class="py-3 px-4 tabular-nums">${esc(duration(e.totalDurationSec))}</td><td class="py-3 px-4 tabular-nums">${esc(duration(e.avgDurationSec))}</td></tr>`).join('')}</tbody></table>
    <div class="p-3 text-[11px] text-ink-muted border-t border-line-subtle">Click a person to see the calls they took.</div></div>`;
}

function log() {
  const f = ui.filter;
  const chips = OUTCOME_FILTERS.map(([id, label]) => `<button type="button" data-action="calls-outcome" data-id="${id}" class="px-3 py-1.5 rounded-md text-xs font-medium ${f.outcome === id ? 'bg-accent-soft text-accent-text' : 'text-ink-secondary hover:bg-subtle'}">${label}</button>`).join('');
  const scope = [f.handler ? `Taken by ${f.handlerName || 'this person'}` : '', f.person ? `Customer: ${f.personName || f.person}` : ''].filter(Boolean)
    .map((t) => `<span class="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-subtle text-xs">${esc(t)}</span>`).join('');
  const rows = ui.log.items.map((c) => callRow(c, {timezone: tz()}));
  return `<div class="space-y-3"><div class="flex flex-wrap items-center gap-1.5">${chips}${scope}${scope ? '<button type="button" data-action="calls-clear" class="text-xs text-accent hover:underline">Clear</button>' : ''}</div>
    <div class="rounded-lg border border-line-subtle bg-surface shadow-xs">${rows.length ? rows.map(rowButton).join('') : emptyState('No calls match', 'Try another filter or a wider period.', 'phone')}
    ${ui.log.next ? '<div class="p-3 text-center border-t border-line-subtle"><button type="button" data-action="calls-more" class="px-3 py-1.5 rounded-md text-xs font-medium border border-line-subtle hover:bg-subtle">Show more</button></div>' : ''}</div>
    <div class="text-[11px] text-ink-muted">${ui.log.total ?? 0} ${ui.log.total === 1 ? 'call' : 'calls'} in this period.</div></div>`;
}

function page() {
  const d = ui.data;
  const tab = (id, label) => `<button type="button" data-action="calls-tab" data-id="${id}" class="px-3 py-1.5 rounded-sm text-xs font-medium ${ui.tab === id ? 'bg-surface text-ink-primary shadow-xs' : 'text-ink-secondary hover:text-ink-primary'}">${label}</button>`;
  return `<div class="space-y-4"><div><h1 class="type-h1">Calls</h1><p class="type-body text-ink-secondary">Who asked for a call, who took it, and how it ended.</p></div>
    <div class="flex items-center bg-subtle p-1 rounded-md border border-line-subtle self-start w-fit">${tab('overview', 'Overview')}${tab('team', 'Team')}${tab('log', 'All calls')}</div>
    ${ui.tab === 'overview' ? overview(d) : ui.tab === 'team' ? team(d) : log()}</div>`;
}

/** One call in a side panel, with a way to the customer, the person who took it and the chat. */
export async function showCall(id) {
  openDrawer('Call', '<div class="text-xs text-ink-muted">Loading…</div>');
  let c;
  try {
    c = await getCallDetail(id);
  } catch (error) {
    openDrawer('Call', `<div class="text-xs text-danger-text">${esc(error?.message || 'This call could not be loaded.')}</div>`);
    return;
  }
  const r = callRow(c, {timezone: tz()});
  const row = (label, value) => (value ? `<div class="flex gap-3 text-xs"><div class="w-32 shrink-0 text-ink-muted">${esc(label)}</div><div class="min-w-0 text-ink-primary break-words">${value}</div></div>` : '');
  const steps = callTimeline(c, {timezone: tz()});
  const handled = c.handledBy ? `<button type="button" data-action="handler-calls" data-id="${esc(c.handledBy.id)}" data-name="${esc(c.handledBy.name)}" class="text-accent hover:underline">${esc(handlerLabel(c.handledBy))}</button>` : esc(handlerLabel(null));
  const same = c.assignedTo?.id && c.assignedTo.id === c.handledBy?.id;
  const seg = (c.handlingSegments || []).map((s) => `${esc(s.employeeName || 'Team member')}${s.durationSec != null ? `, ${esc(duration(s.durationSec))} from taking it to letting go` : ''}`).join('<br>');
  openDrawer('Call', `<div class="space-y-3">
    <div class="flex flex-wrap items-center gap-2">${pill(r.outcome, r.tone)}${pill('Human call', 'neutral')}</div>
    ${row('Customer', c.personKey ? `<button type="button" data-action="open-customer" data-id="${esc(c.personKey)}" class="text-accent hover:underline">${esc(r.who)}</button>` : esc(r.who))}
    ${row('Contact', esc(r.contact))}
    ${row('Started by', 'The customer (incoming)')}
    ${row(same ? 'Assigned and handled by' : 'Assigned to', same ? handled : esc(r.assigned))}
    ${same ? '' : row('Handled by', handled)}
    ${row('Handling', seg)}
    ${row('Talk time', c.outcome === 'completed' ? esc(duration(c.durationSec)) : '')}
    ${row('Why they asked', esc(r.reason))}
    ${row('What went wrong', esc(c.failureReason))}
    ${row('Recording', esc(r.recording))}
    ${steps.length ? `<div><div class="type-small font-semibold mb-1">Timeline</div><div class="space-y-1">${steps.map((s) => `<div class="flex justify-between text-xs"><span class="text-ink-secondary">${esc(s.label)}</span><span class="text-ink-muted tabular-nums">${esc(s.at)}</span></div>`).join('')}</div></div>` : ''}
  </div>`, c.conversationId ? `<button type="button" data-action="open-chat" data-id="${esc(c.conversationId)}" class="px-3 py-2 rounded-md text-xs font-medium border border-line-subtle hover:bg-subtle">Open the chat</button>` : '');
}

actions['calls-tab'] = async (el) => {
  ui.tab = el.getAttribute('data-id');
  if (ui.tab === 'log' && !ui.log.items.length) await fetchLog(false).catch((e) => toast('Could not load calls', e?.message || '', 'danger'));
  await redraw();
};
actions['calls-outcome'] = async (el) => {
  ui.filter.outcome = el.getAttribute('data-id') || '';
  await fetchLog(false).catch((e) => toast('Could not load calls', e?.message || '', 'danger'));
  await redraw();
};
actions['calls-more'] = async () => {
  await fetchLog(true).catch((e) => toast('Could not load more', e?.message || '', 'danger'));
  await redraw();
};
actions['calls-clear'] = async () => {
  ui.filter = {outcome: ui.filter.outcome, handler: '', person: '', handlerName: '', personName: ''};
  await fetchLog(false);
  await redraw();
};
/** Every call one team member took (from the Team table or from a call). */
actions['handler-calls'] = async (el) => {
  ui.filter = {outcome: '', handler: el.getAttribute('data-id') || '', handlerName: el.getAttribute('data-name') || '', person: '', personName: ''};
  ui.tab = 'log';
  const app = await import('../app.js');
  if (state.screen !== 'calls') await app.show('calls');
  else {
    await fetchLog(false).catch((e) => toast('Could not load calls', e?.message || '', 'danger'));
    app.redraw();
  }
  closeDrawer();
};
/** Every call one customer made, opened from the customer's page. */
actions['person-calls'] = async (el) => {
  ui.filter = {outcome: '', handler: '', handlerName: '', person: el.getAttribute('data-id') || '', personName: el.getAttribute('data-name') || ''};
  ui.tab = 'log';
  const app = await import('../app.js');
  await app.show('calls');
};
actions['open-call'] = (el) => showCall(el.getAttribute('data-id'));
