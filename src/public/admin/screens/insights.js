// Catalog insights (what shoppers asked for, saw and added) and AI quality (how the agent is doing).
// Both are counted from what was recorded for this store; nothing is estimated.
import {actions, screens} from '../core.js';
import {getOverview, getPerformance} from '../api.js';
import {formatNumber} from '../lib/format.js';
import {barsSummary, dailyBars, formatDuration, performanceTiles} from '../lib/performance.js';
import {funnelBars} from '../lib/overview.js';
import {emptyState, esc} from '../ui.js';

const TABS = [
  {id: 'notFound', key: 'searchedNotFound', label: 'Asked for, not found', hint: 'Things shoppers asked for that the store could not give them. Good ideas for what to stock.', cols: ['What they asked for', 'Times asked']},
  {id: 'shown', key: 'productsShown', label: 'Most shown', hint: 'Products the assistant put in front of shoppers most often.', cols: ['Product', 'Times shown']},
  {id: 'carted', key: 'productsAdded', label: 'Most added to cart', hint: 'Products shoppers added to the cart after talking to the assistant.', cols: ['Product', 'Times added']},
];
const ui = {tab: 'notFound'};

screens.catalog = {
  load: ({range}) => getOverview(range),
  html: (now) => {
    const tab = TABS.find((t) => t.id === ui.tab) || TABS[0];
    const rows = now.top?.[tab.key] || [];
    return `<div class="space-y-4"><div><h1 class="type-h1">Catalog insights</h1><p class="type-body text-ink-secondary">What shoppers ask for, which products get shown, and which get added to the cart.</p></div>
      <div class="flex items-center gap-1.5 overflow-x-auto border-b border-line-subtle pb-2">${TABS.map((t) => `<button type="button" data-action="cat-tab" data-tab="${t.id}" class="px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${ui.tab === t.id ? 'bg-accent-soft text-accent-text font-semibold' : 'text-ink-secondary hover:bg-subtle'}">${t.label}</button>`).join('')}</div>
      <p class="text-xs text-ink-secondary">${esc(tab.hint)} (${esc(now.range.from)} to ${esc(now.range.to)})</p>
      <div class="rounded-lg border border-line-subtle bg-surface shadow-xs overflow-hidden">${rows.length ? `<div class="overflow-x-auto"><table class="w-full text-left border-collapse"><thead><tr class="border-b border-line-subtle bg-subtle/60 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary"><th class="py-3 px-4">${tab.cols[0]}</th><th class="py-3 px-4 text-right">${tab.cols[1]}</th></tr></thead>
        <tbody class="divide-y divide-line-subtle text-xs">${rows.map((r) => `<tr class="hover:bg-subtle/50"><td class="py-3 px-4 font-semibold text-ink-primary">${esc(r.name)}</td><td class="py-3 px-4 text-right tabular-nums font-semibold">${formatNumber(r.count)}</td></tr>`).join('')}</tbody></table></div>` : emptyState('Nothing here yet', tab.id === 'notFound' ? 'Searches the store could not match will be listed here as shoppers ask.' : 'Pick a longer period to see more.', 'compass')}</div></div>`;
  },
};
actions['cat-tab'] = async (el) => {
  ui.tab = el.getAttribute('data-tab');
  (await import('../app.js')).redraw();
};

const TONE_CLASS = {caution: 'text-warning-text', critical: 'text-danger-text', '': ''};

function bars(series, key, format, label) {
  const d = dailyBars(series, key);
  return `<figure><svg viewBox="0 0 ${d.width} ${d.height}" class="w-full h-40" role="img" aria-label="${esc(label)}. ${esc(barsSummary(series, key, format))}" preserveAspectRatio="none">${d.bars.map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="2" fill="var(--accent-primary)"><title>${esc(b.date)}: ${esc(format(b.value))}</title></rect>`).join('')}</svg>
    <figcaption class="flex justify-between text-[10px] text-ink-muted mt-1"><span>${esc(series[0]?.date || '')}</span><span>${esc(series[series.length - 1]?.date || '')}</span></figcaption></figure>`;
}

screens.quality = {
  load: ({range}) => getPerformance(range),
  html: (p) => {
    const tiles = performanceTiles(p.totals);
    const funnel = funnelBars(p.funnel);
    return `<div class="space-y-6"><div><h1 class="type-h1">AI quality &amp; reliability</h1><p class="type-body text-ink-secondary">How many chats the assistant handled alone, how fast it replied, and how often it failed (${esc(p.range.from)} to ${esc(p.range.to)}).</p></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">${tiles.map((t) => `<div class="p-4 rounded-lg border border-line-subtle bg-surface shadow-xs"><div class="text-xs text-ink-secondary">${esc(t.label)}</div><div class="type-h1 tabular-nums mt-1 ${TONE_CLASS[t.tone] || ''}">${esc(t.value)}</div><div class="text-[11px] text-ink-muted mt-0.5">${esc(t.note)}</div></div>`).join('')}</div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="p-5 rounded-lg border border-line-subtle bg-surface shadow-xs"><h2 class="type-h2 mb-1">Replies per day</h2><p class="type-caption text-ink-secondary mb-3">${formatNumber(p.totals.replies)} replies in total</p>${p.series.length ? bars(p.series, 'replies', (n) => `${n} replies`, 'Replies per day') : emptyState('No replies yet')}</div>
        <div class="p-5 rounded-lg border border-line-subtle bg-surface shadow-xs"><h2 class="type-h2 mb-1">Average reply time per day</h2><p class="type-caption text-ink-secondary mb-3">Overall ${esc(formatDuration(p.totals.averageResponseMs))}</p>${p.series.length ? bars(p.series, 'averageResponseMs', formatDuration, 'Average reply time per day') : emptyState('No replies yet')}</div>
        <div class="p-5 rounded-lg border border-line-subtle bg-surface shadow-xs"><h2 class="type-h2 mb-1">Failed replies per day</h2><p class="type-caption text-ink-secondary mb-3">${formatNumber(p.totals.failedReplies)} could not be written</p>${p.series.length ? bars(p.series, 'failed', (n) => `${n} failed`, 'Failed replies per day') : emptyState('No replies yet')}</div>
        <div class="p-5 rounded-lg border border-line-subtle bg-surface shadow-xs"><h2 class="type-h2 mb-3">How far chats get</h2>${funnel.length && funnel[0].count ? `<div class="space-y-3">${funnel.map((st) => `<div><div class="flex justify-between text-xs mb-1 tabular-nums"><span class="font-medium">${esc(st.label)}</span><span class="text-ink-secondary">${formatNumber(st.count)}</span></div><div class="w-full h-2.5 rounded-pill bg-subtle overflow-hidden"><div class="h-full rounded-pill bg-accent" style="width:${st.percent}%"></div></div></div>`).join('')}</div>` : emptyState('No chats in this period')}</div>
      </div>
      <p class="text-[11px] text-ink-muted">Counted from the replies and chats recorded for your store. Nothing here is estimated.</p></div>`;
  },
};
