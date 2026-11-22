// Home: the numbers of the chosen period, where chats end up, what needs the owner, and the latest chats.
import {actions, screens, state} from '../core.js';
import {getCallAnalytics, getConversations, getOverview, getSupportState} from '../api.js';
import {changeText, previousRange} from '../lib/dateRange.js';
import {formatMoney, formatNumber} from '../lib/format.js';
import {chatRow} from '../lib/chats.js';
import {attentionItems, funnelBars, ordersNote} from '../lib/overview.js';
import {debounce, emptyState, esc, pill, sparkline} from '../ui.js';
import {sup} from '../support.js';
import {formatDuration, percent} from '../lib/performance.js';
import {duration as callDuration} from '../lib/calls.js';

const TONE = {success: 'success', caution: 'warning', info: 'accent', call: 'accent', neutral: 'neutral', critical: 'danger'};

screens.home = {
  async load({range}) {
    const prev = previousRange(range);
    const [now, before, recent, live, callStats] = await Promise.all([
      getOverview(range),
      getOverview(prev).catch(() => null),
      getConversations({from: range.from, to: range.to, limit: 6}).catch(() => ({items: []})),
      getSupportState().catch(() => null),
      getCallAnalytics({from: range.from, to: range.to}).catch(() => null),
    ]);
    return {now, before, recent: recent.items, range, live, callStats};
  },

  html({now, before, recent, range, live, callStats}) {
    const t = now.totals;
    const cur = state.store.currency || t.revenue?.currency || '';
    const money = (n) => formatMoney(n, t.revenue?.currency || cur);
    const series = now.series || [];
    const delta = (a, b) => changeText(a, b);
    const b = before?.totals;
    const sameCurrency = b && b.revenue?.currency === t.revenue?.currency;
    const kpis = [
      {id: 'chats', label: 'Conversations', val: formatNumber(t.conversations), sub: `${formatNumber(t.visitors)} visitors`, points: series.map((d) => d.conversations), color: '#4F46E5', delta: b ? delta(t.conversations, b.conversations) : ''},
      {id: 'orders', label: 'Orders from chats', val: formatNumber(t.orders), sub: ordersNote(t.ordersBySource) || 'No orders yet', points: series.map((d) => d.orders), color: '#16A34A', delta: b ? delta(t.orders, b.orders) : ''},
      {id: 'revenue', label: 'Revenue from chats', val: money(t.revenue?.amount), sub: t.otherRevenue?.length ? `Also ${t.otherRevenue.map((r) => formatMoney(r.amount, r.currency)).join(', ')}` : `Average order ${money(t.averageOrderValue)}`, points: series.map((d) => d.revenue), color: '#7C3AED', delta: sameCurrency ? delta(t.revenue?.amount, b.revenue?.amount) : ''},
      {id: 'conv', label: 'Chat-to-order rate', val: t.conversations ? percent(t.conversionRate) : '—', sub: 'Chats that ended in an order', points: [], color: '#0891B2', delta: ''},
      {id: 'speed', label: 'Average reply time', val: formatDuration(t.averageResponseMs), sub: t.failedReplies ? `${t.failedReplies} replies failed` : 'No failed replies', points: [], color: '#D97706', delta: ''},
      {id: 'follow', label: 'Waiting on you', val: formatNumber(state.attention?.todo ?? t.needsFollowUp), sub: 'Chats that need a person', points: [], color: '#DC2626', delta: '', warn: (state.attention?.todo ?? t.needsFollowUp) > 0},
    ];
    const steps = funnelBars(now.funnel);
    const a = state.attention;
    const items = [];
    if (a?.calls?.waiting) items.push({badge: 'Call request', tone: 'danger', title: `${a.calls.waiting} ${a.calls.waiting === 1 ? 'shopper asked' : 'shoppers asked'} for a call`, sub: a.calls.overdue ? `${a.calls.overdue} overdue` : 'Waiting for you to confirm', label: 'Open calls', nav: 'bookings'});
    if (a?.inbox?.waiting) items.push({badge: 'Waiting on you', tone: 'warning', title: `${a.inbox.waiting} ${a.inbox.waiting === 1 ? 'chat needs' : 'chats need'} a reply from you`, sub: 'The AI could not settle these', label: 'Open inbox', nav: 'conversations'});
    if (a?.files) items.push({badge: 'Files', tone: 'accent', title: `${a.files} ${a.files === 1 ? 'chat has' : 'chats have'} photos or files`, sub: 'Sent by shoppers', label: 'Look', nav: 'conversations'});
    for (const x of attentionItems(t, range)) if (x.id !== 'follow') items.push({badge: x.id === 'failed' ? 'Failed replies' : 'Dropped at checkout', tone: 'warning', title: x.text, sub: `${range.from} to ${range.to}`, label: 'See chats', nav: 'conversations'});

    const topShown = now.top?.productsShown || [];
    const topAdded = now.top?.productsAdded || [];
    const topList = (rows) => rows.length ? rows.slice(0, 5).map((r) => `<div class="py-2.5 flex items-center justify-between gap-2"><div class="text-xs font-medium text-ink-primary truncate">${esc(r.name)}</div><div class="text-[11px] text-ink-muted tabular-nums shrink-0">${formatNumber(r.count)}×</div></div>`).join('') : '<div class="py-6 text-center text-xs text-ink-muted">Nothing yet in this period.</div>';

    return `<div class="space-y-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 class="type-h1">${esc(state.store.name || 'Your store')}: your assistant handled <span class="text-accent tabular-nums">${formatNumber(t.conversations)} ${t.conversations === 1 ? 'chat' : 'chats'}</span> (${esc(range.from === range.to ? range.from : `${range.from} – ${range.to}`)})</h1>
          <p class="type-body text-ink-secondary mt-0.5">${formatNumber(t.messages)} replies sent · ${t.channels?.voice ? `${formatNumber(t.channels.voice)} voice chats · ` : ''}${t.failedReplies ? `${t.failedReplies} could not be written` : 'every reply went through'}</p>
        </div>
        <div class="flex items-center gap-2">
          <button type="button" data-nav="train" class="px-3 py-2 rounded-md text-xs font-medium border border-line-subtle bg-surface hover:bg-subtle flex items-center gap-1.5"><i data-lucide="sliders-horizontal" class="w-3.5 h-3.5 text-accent"></i>Train assistant</button>
          <button type="button" data-nav="conversations" class="px-3.5 py-2 rounded-md text-xs font-medium bg-accent-gradient text-white shadow-xs flex items-center gap-1.5"><i data-lucide="message-square" class="w-3.5 h-3.5"></i>Open inbox${a?.todo ? ` (${a.todo})` : ''}</button>
        </div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        ${kpis.map((k) => `<div class="p-4 rounded-lg border border-line-subtle bg-surface shadow-xs flex flex-col justify-between">
          <div class="flex items-center justify-between gap-2"><span class="type-small text-ink-secondary">${k.label}</span>${k.delta ? `<span class="px-2 py-0.5 text-[11px] font-medium rounded-pill tabular-nums ${k.delta.startsWith('Down') ? 'bg-warning-soft text-warning-text' : 'bg-success-soft text-success-text'}">${esc(k.delta)}</span>` : k.warn ? pill('Needs you', 'warning') : ''}</div>
          <div class="flex items-end justify-between gap-3 mt-3"><div><div class="type-display tabular-nums tracking-tight">${esc(k.val)}</div><div class="type-caption text-ink-muted mt-0.5">${esc(k.sub)}</div></div><div class="shrink-0">${sparkline(k.points, k.color, k.id)}</div></div>
        </div>`).join('')}
      </div>

      ${liveHelpCard(live)}
      ${callsCard(callStats)}

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div class="lg:col-span-7 p-5 rounded-lg border border-line-subtle bg-surface shadow-xs">
          <div class="flex items-center justify-between mb-4"><div><h2 class="type-h2">Where chats end up</h2><p class="type-caption text-ink-secondary">How chats turn into orders in this period</p></div>${t.conversations ? `<span class="px-2.5 py-1 rounded-pill text-xs font-semibold bg-accent-soft text-accent-text tabular-nums">${percent(t.conversionRate)} chat-to-order</span>` : ''}</div>
          ${steps.length && steps[0].count ? `<div class="space-y-3">${steps.map((st, i) => {
            const prevCount = i ? steps[i - 1].count : 0;
            const drop = i && prevCount ? Math.round(((prevCount - st.count) / prevCount) * 100) : 0;
            return `<div><div class="flex items-center justify-between text-xs mb-1"><span class="font-medium text-ink-primary flex items-center gap-1.5"><span class="w-4 h-4 rounded-full bg-subtle text-[10px] font-mono flex items-center justify-center text-ink-secondary">${i + 1}</span>${esc(st.label)}</span><span class="tabular-nums flex items-center gap-2"><strong class="text-ink-primary">${formatNumber(st.count)}</strong><span class="text-ink-muted">(${st.percent}%)</span>${drop > 0 ? `<span class="px-1.5 py-0.5 text-[10px] rounded bg-warning-soft text-warning-text">↓ ${drop}% drop-off</span>` : ''}</span></div><div class="w-full h-2.5 rounded-pill bg-subtle overflow-hidden"><div class="h-full rounded-pill bg-accent-gradient transition-all duration-300" style="width:${st.percent}%"></div></div></div>`;
          }).join('')}</div>` : emptyState('No chats in this period', 'Pick a longer period to see more.', 'bar-chart-3')}
        </div>

        <div class="lg:col-span-5 p-5 rounded-lg border border-line-subtle bg-surface shadow-xs">
          <div class="mb-3"><h2 class="type-h2 flex items-center gap-1.5">Needs your attention${items.length ? `<span class="px-1.5 py-0.5 text-xs rounded-pill bg-danger-soft text-danger-text tabular-nums">${items.length}</span>` : ''}</h2><p class="type-caption text-ink-secondary">Calls, chats waiting on you and checkouts that stopped</p></div>
          <div class="divide-y divide-line-subtle">${items.length ? items.map((it) => `<div class="py-2.5 flex items-start justify-between gap-2"><div class="min-w-0"><div class="mb-0.5">${pill(it.badge, it.tone)}</div><div class="text-xs font-medium text-ink-primary leading-snug">${esc(it.title)}</div><div class="text-[11px] text-ink-muted mt-0.5">${esc(it.sub)}</div></div><button type="button" data-nav="${it.nav}" class="shrink-0 px-2.5 py-1 rounded-sm text-xs font-medium border border-line-subtle hover:bg-subtle">${esc(it.label)}</button></div>`).join('') : '<div class="py-8 text-center text-xs text-ink-muted">All caught up. Nothing is waiting for you.</div>'}</div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div class="lg:col-span-5 p-5 rounded-lg border border-line-subtle bg-surface shadow-xs">
          <div class="mb-3"><h2 class="type-h2">What shoppers looked at</h2><p class="type-caption text-ink-secondary">Products the assistant showed most</p></div>
          <div class="divide-y divide-line-subtle">${topList(topShown)}</div>
          <div class="mt-4 mb-1"><h3 class="type-small text-ink-secondary font-semibold">Added to cart most</h3></div>
          <div class="divide-y divide-line-subtle">${topList(topAdded)}</div>
          <button type="button" data-nav="catalog" class="mt-3 text-xs text-accent hover:underline">See catalog insights →</button>
        </div>

        <div class="lg:col-span-7 p-5 rounded-lg border border-line-subtle bg-surface shadow-xs">
          <div class="flex items-center justify-between mb-3"><div><h2 class="type-h2">Recent shopper conversations</h2><p class="type-caption text-ink-secondary">Open any chat to read it or reply</p></div><button type="button" data-nav="conversations" class="text-xs text-accent hover:underline">Open inbox →</button></div>
          <div class="divide-y divide-line-subtle">${recent.length ? recent.map((c) => {
            const r = chatRow(c, {timezone: state.store.timezone});
            return `<button type="button" data-action="open-chat" data-id="${esc(c.id)}" class="w-full py-2.5 text-left flex items-center justify-between gap-3 hover:bg-subtle/60 px-2 -mx-2 rounded"><div class="min-w-0 flex-1"><div class="flex items-center gap-2"><span class="text-xs font-semibold text-ink-primary truncate">${esc(r.who)}</span>${pill(r.state.label, TONE[r.state.tone] || 'neutral')}</div><div class="text-xs text-ink-secondary truncate mt-0.5">${esc(r.preview)}</div></div><div class="text-right shrink-0 tabular-nums"><div class="text-[11px] text-ink-muted">${esc(r.when)}</div><div class="text-[11px] text-ink-muted">${esc(r.result)}</div></div></button>`;
          }).join('') : emptyState('No chats yet in this period', '', 'message-square')}</div>
        </div>
      </div>
    </div>`;
  },
};

/** Who is on and what is waiting for a person, counted now. Each number opens the chats or page it is about. */
/** The period's calls at a glance (counted from real call records). The full picture is on the Calls screen. */
function callsCard(d) {
  if (!d) return '';
  const h = d.human;
  const tiles = [
    {label: 'Calls asked for', value: h.total},
    {label: 'Completed', value: h.completed, tone: 'text-success-text'},
    {label: 'Missed', value: h.missed, tone: h.missed ? 'text-danger-text' : ''},
    {label: 'Failed', value: h.failed, tone: h.failed ? 'text-danger-text' : ''},
    {label: 'AI voice sessions', value: d.ai.sessions},
    {label: 'Talk time', text: callDuration(h.totalDurationSec)},
  ];
  const top = d.topCustomers.slice(0, 3).map((c) => `<button type="button" data-action="open-customer" data-id="${esc(c.id)}" class="text-xs text-accent hover:underline">${esc(c.name || 'Visitor')} (${c.calls})</button>`).join(' · ');
  return `<div class="p-4 rounded-lg border border-line-subtle bg-surface shadow-xs"><div class="flex items-center justify-between mb-3"><h2 class="type-h2">Calls</h2><button type="button" data-nav="calls" class="text-xs text-accent hover:underline">See all calls</button></div>
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">${tiles.map((t) => `<div class="p-3 rounded-md bg-subtle/50"><div class="text-[11px] text-ink-muted">${esc(t.label)}</div><div class="type-display tabular-nums ${t.tone || ''}">${t.text ?? formatNumber(t.value)}</div></div>`).join('')}</div>
    ${top ? `<div class="mt-3 text-[11px] text-ink-muted">Most calls: ${top}</div>` : ''}
    ${d.coverage.complete ? '' : `<div class="mt-2 text-[11px] text-warning-text">${esc(d.coverage.note)}</div>`}</div>`;
}

function liveHelpCard(live) {
  const m = live?.metrics;
  if (!m) return '';
  if (!m.enabled) {
    return `<div class="p-4 rounded-lg border border-dashed border-line-strong bg-surface flex flex-wrap items-center justify-between gap-3"><div><h2 class="type-h2">Live help from a person</h2><p class="type-caption text-ink-secondary">Let a shopper who asks for a person talk to you right now, by audio, from this dashboard.</p></div><button type="button" data-nav="settings" class="px-3 py-2 rounded-md text-xs font-medium border border-line-subtle hover:bg-subtle">Turn it on in Settings</button></div>`;
  }
  const tiles = [
    {label: 'Online', value: m.online, nav: 'settings', tone: m.online ? 'text-success-text' : ''},
    {label: 'Busy on a call', value: m.busy, filter: 'human_live'},
    {label: 'Active calls', value: m.activeCalls, filter: 'human_live'},
    {label: 'Customers waiting', value: m.waiting, filter: 'human_waiting', tone: m.waiting ? 'text-danger-text' : ''},
    {label: 'Pending requests', value: m.pendingRequests, filter: 'human'},
    {label: 'Callbacks scheduled', value: m.scheduledCallbacks, nav: 'bookings'},
  ];
  const nobody = m.audio && m.online === 0 && m.busy === 0
    ? `<div class="mb-3 p-3 rounded-md bg-warning-soft/60 flex flex-wrap items-center justify-between gap-2"><span class="text-xs text-warning-text">Nobody is taking calls right now, so a shopper who asks for a person will be told nobody is available.</span><button type="button" data-action="support-open-console" class="px-3 py-1.5 rounded-md text-xs font-semibold bg-accent-gradient text-white">Open call window</button></div>` : '';
  return `<div class="p-4 rounded-lg border border-line-subtle bg-surface shadow-xs"><div class="flex items-center justify-between mb-3"><h2 class="type-h2">Live help</h2>${m.audio ? '' : pill('Chat only', 'neutral')}</div>${nobody}
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">${tiles.map((t) => `<button type="button" ${t.nav ? `data-nav="${t.nav}"` : `data-action="open-human" data-filter="${t.filter}"`} class="text-left p-3 rounded-md bg-subtle/50 hover:bg-subtle transition-colors focus-ring"><div class="text-[11px] text-ink-muted">${esc(t.label)}</div><div class="type-display tabular-nums ${t.tone || ''}">${formatNumber(t.value)}</div></button>`).join('')}</div></div>`;
}

actions['open-human'] = async (el) => {
  state.openFilter = el.getAttribute('data-filter');
  const {show} = await import('../app.js');
  return show('conversations');
};

// who is on and what is waiting changes by the minute: keep the Live help numbers current without reloading the page
sup.onChange.add(debounce(async () => {
  if (state.screen !== 'home' || state.view.status !== 'ready') return;
  try {
    state.view.data.live = await getSupportState();
    const {redraw} = await import('../app.js');
    redraw();
  } catch { /* the next change tries again */ }
}, 700));

// opening a chat from anywhere: the conversations screen shows it
actions['open-chat'] = async (el) => {
  state.openConv = el.getAttribute('data-id');
  const {show} = await import('../app.js');
  return show('conversations');
};
