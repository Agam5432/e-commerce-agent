// Orders & Customers: the orders that came out of chats (payment and delivery status from Shopify) and the people
// who chatted, with the privacy tool to erase one person's data.
import {actions, screens, state} from '../core.js';
import {ApiError, erasePerson, getCustomer, getCustomers, getOrder, getOrders} from '../api.js';
import {orderDetailView, orderRow} from '../lib/orders.js';
import {customerRow, customerSummary, orderTotal} from '../lib/customers.js';
import {chatRow} from '../lib/chats.js';
import {callRow, duration} from '../lib/calls.js';
import {formatWhen} from '../lib/format.js';
import {closeModal, debounce, emptyState, esc, openDrawer, openModal, pill, toast, closeDrawer} from '../ui.js';

const TONE = {success: 'success', caution: 'warning', info: 'accent', call: 'accent', neutral: 'neutral', critical: 'danger'};
const ui = {tab: 'orders', q: '', orders: {items: [], next: null, total: 0}, customers: {items: [], next: null, total: 0}, sort: 'recent'};

async function fetchOrders(range, append = false) {
  const page = await getOrders({from: range.from, to: range.to, q: ui.q || undefined, limit: 25, cursor: append ? ui.orders.next : undefined});
  ui.orders = {items: append ? [...ui.orders.items, ...page.items] : page.items, next: page.nextCursor, total: page.total ?? ui.orders.total};
}
async function fetchCustomers(range, append = false) {
  const page = await getCustomers({from: range.from, to: range.to, q: ui.q || undefined, sort: ui.sort, limit: 25, cursor: append ? ui.customers.next : undefined});
  ui.customers = {items: append ? [...ui.customers.items, ...page.items] : page.items, next: page.nextCursor, total: page.total ?? ui.customers.total};
}

screens.orders = {
  async load({range}) {
    await Promise.all([fetchOrders(range), fetchCustomers(range)]);
    return {range};
  },
  html: () => page(),
};

async function redraw() {
  const {redraw: draw} = await import('../app.js');
  draw();
}

function ordersTable() {
  const rows = ui.orders.items.map((o) => orderRow(o, {timezone: state.store.timezone}));
  if (!rows.length) return emptyState('No orders in this period', 'Orders placed through the chat show up here.', 'shopping-bag');
  return `<div class="overflow-x-auto"><table class="w-full text-left border-collapse"><thead><tr class="border-b border-line-subtle bg-subtle/60 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
    <th class="py-3 px-4">Order</th><th class="py-3 px-4">Customer</th><th class="py-3 px-4">Placed by</th><th class="py-3 px-4">Payment</th><th class="py-3 px-4">Status (Shopify)</th><th class="py-3 px-4 text-right">Total</th></tr></thead>
    <tbody class="divide-y divide-line-subtle text-xs">${rows.map((o) => `<tr data-action="open-order" data-name="${esc(o.order)}" tabindex="0" class="hover:bg-subtle/60 cursor-pointer transition-colors">
      <td class="py-3 px-4 font-mono font-semibold text-accent">${esc(o.order)}<div class="text-[10px] font-sans font-normal text-ink-muted">${esc(o.date)}</div></td>
      <td class="py-3 px-4 font-medium">${esc(o.customer)}<div class="text-[11px] text-ink-muted">${esc(o.customerDetail)}</div></td>
      <td class="py-3 px-4">${o.placedBy === 'Agent' ? '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill bg-accent-soft text-accent-text text-[11px] font-semibold"><i data-lucide="sparkles" class="w-3 h-3"></i>AI in chat</span>' : pill(o.placedBy, 'neutral')}</td>
      <td class="py-3 px-4 text-ink-secondary">${esc(o.payment)}</td>
      <td class="py-3 px-4"><div class="flex flex-wrap gap-1">${o.badges.length ? o.badges.map((b) => pill(b.label, TONE[b.tone] || 'neutral')).join('') : '<span class="text-ink-muted">—</span>'}</div></td>
      <td class="py-3 px-4 text-right font-semibold tabular-nums">${esc(o.total)}<div class="text-[10px] font-normal text-ink-muted">${esc(o.items)} item(s)</div></td></tr>`).join('')}</tbody></table></div>
    ${ui.orders.next ? '<div class="p-3 text-center border-t border-line-subtle"><button type="button" data-action="more-orders" class="px-3 py-1.5 rounded-md text-xs font-medium border border-line-subtle hover:bg-subtle">Show more</button></div>' : ''}`;
}

function customersTable() {
  const rows = ui.customers.items.map((p) => customerRow(p, {timezone: state.store.timezone}));
  if (!rows.length) return emptyState('Nobody in this period', 'People who chat with your assistant show up here.', 'users');
  return `<div class="overflow-x-auto"><table class="w-full text-left border-collapse"><thead><tr class="border-b border-line-subtle bg-subtle/60 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">
    <th class="py-3 px-4">Customer</th><th class="py-3 px-4">Type</th><th class="py-3 px-4">Chats</th><th class="py-3 px-4">Calls</th><th class="py-3 px-4">Orders</th><th class="py-3 px-4">Last seen</th><th class="py-3 px-4 text-right">Total spent</th><th class="py-3 px-4 text-right">Actions</th></tr></thead>
    <tbody class="divide-y divide-line-subtle text-xs">${rows.map((c) => `<tr data-action="open-customer" data-id="${esc(c.id)}" tabindex="0" class="hover:bg-subtle/60 cursor-pointer transition-colors">
      <td class="py-3 px-4 font-semibold text-ink-primary">${esc(c.who)}<div class="text-[11px] font-normal text-ink-muted">${esc(c.detail)}</div></td>
      <td class="py-3 px-4">${pill(c.kind, TONE[c.kindTone] || 'neutral')}</td>
      <td class="py-3 px-4 tabular-nums">${c.chats}</td><td class="py-3 px-4 tabular-nums" title="${c.aiVoiceSessions} AI voice sessions">${c.humanCalls}</td><td class="py-3 px-4 tabular-nums">${c.orders}</td><td class="py-3 px-4 text-ink-secondary">${esc(c.lastSeen)}</td>
      <td class="py-3 px-4 text-right font-semibold tabular-nums">${esc(c.spend)}</td>
      <td class="py-3 px-4 text-right"><button type="button" data-action="open-customer" data-id="${esc(c.id)}" class="px-2.5 py-1 rounded border border-line-subtle text-xs hover:bg-subtle">Timeline &amp; Privacy</button></td></tr>`).join('')}</tbody></table></div>
    ${ui.customers.next ? '<div class="p-3 text-center border-t border-line-subtle"><button type="button" data-action="more-customers" class="px-3 py-1.5 rounded-md text-xs font-medium border border-line-subtle hover:bg-subtle">Show more</button></div>' : ''}`;
}

function page() {
  const tabBtn = (id, label, n) => `<button type="button" data-action="oc-tab" data-tab="${id}" class="px-3 py-1.5 rounded-sm text-xs font-medium ${ui.tab === id ? 'bg-surface text-ink-primary shadow-xs' : 'text-ink-secondary hover:text-ink-primary'}">${label} (${n})</button>`;
  return `<div class="space-y-4">
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3"><div><h1 class="type-h1">Orders &amp; Customers</h1><p class="type-body text-ink-secondary">Orders your assistant helped place, and the people who chatted. Erase a person's data on request.</p></div>
      <div class="flex items-center bg-subtle p-1 rounded-md border border-line-subtle self-start">${tabBtn('orders', 'Orders', ui.orders.total)}${tabBtn('customers', 'Customers', ui.customers.total)}</div></div>
    <div class="p-3 rounded-lg border border-line-subtle bg-surface flex flex-wrap items-center justify-between gap-2">
      <div class="relative flex-1 min-w-[220px] max-w-md"><i data-lucide="search" class="w-3.5 h-3.5 text-ink-muted absolute left-2.5 top-2.5"></i>
        <input id="oc-search-input" type="search" value="${esc(ui.q)}" placeholder="${ui.tab === 'orders' ? 'Order number' : 'Name, email or phone'}" aria-label="Search" class="w-full pl-8 pr-3 py-1.5 text-xs rounded-sm border border-line-subtle bg-subtle/40 focus-ring" /></div>
      ${ui.tab === 'customers' ? `<select id="oc-sort" aria-label="Sort" class="px-2 py-1.5 text-xs rounded border border-line-subtle bg-surface"><option value="recent" ${ui.sort === 'recent' ? 'selected' : ''}>Most recent</option><option value="spend" ${ui.sort === 'spend' ? 'selected' : ''}>Biggest spenders</option><option value="chats" ${ui.sort === 'chats' ? 'selected' : ''}>Most chats</option></select>` : '<span class="text-xs text-ink-muted">Click a row for the full order from Shopify</span>'}</div>
    <div class="rounded-lg border border-line-subtle bg-surface shadow-xs overflow-hidden">${ui.tab === 'orders' ? ordersTable() : customersTable()}</div></div>`;
}

const rangeNow = async () => (await import('../core.js')).range();

actions['oc-tab'] = async (el) => {
  ui.tab = el.getAttribute('data-tab');
  await redraw();
};
actions['more-orders'] = async () => { await fetchOrders(await rangeNow(), true); await redraw(); };
actions['more-customers'] = async () => { await fetchCustomers(await rangeNow(), true); await redraw(); };

actions['open-order'] = async (el) => {
  const name = el.getAttribute('data-name');
  openDrawer(`Order ${esc(name)}`, '<div class="text-xs text-ink-muted">Loading from Shopify…</div>');
  const data = await getOrder(name);
  const v = orderDetailView(data, {timezone: state.store.timezone, handle: state.store.shop.replace(/\.myshopify\.com$/, '')});
  const addr = (a) => (a ? `<div class="text-xs text-ink-secondary">${esc(a.name || '')}<br>${(a.lines || []).map(esc).join('<br>')}${a.phone ? `<br>${esc(a.phone)}` : ''}</div>` : '<div class="text-xs text-ink-muted">—</div>');
  openDrawer(`Order ${esc(v.name)}`, `<div class="space-y-4">
    <div class="flex flex-wrap gap-1.5">${v.badges.map((b) => pill(b.label, TONE[b.tone] || 'neutral')).join('')}${pill(v.placedBy, 'accent')}</div>
    ${v.notice ? `<div class="p-2.5 rounded-md bg-warning-soft text-warning-text text-xs">${esc(v.notice)}</div>` : ''}
    ${v.cancelNote ? `<div class="text-xs text-danger-text">${esc(v.cancelNote)}</div>` : ''}
    ${v.cancelReason ? `<div class="p-2.5 rounded-md border border-line-subtle text-xs space-y-0.5"><div class="type-small font-semibold">Cancellation reason</div><div class="text-ink-primary break-words">${esc(v.cancelReason)}</div><div class="text-ink-muted">Cancelled through: ${esc(v.cancelledThrough)}${v.cancelRequested ? ` · ${esc(v.cancelRequested)}` : ''}</div></div>` : ''}
    <div class="text-xs text-ink-muted">Placed ${esc(v.placed)} · Payment: ${esc(v.payment)}</div>
    ${v.items.length ? `<div class="rounded-md border border-line-subtle divide-y divide-line-subtle">${v.items.map((i) => `<div class="p-2.5 flex justify-between gap-2 text-xs"><div><div class="font-medium text-ink-primary">${i.quantity}× ${esc(i.title)}</div>${i.variant ? `<div class="text-ink-muted">${esc(i.variant)}</div>` : ''}</div><div class="tabular-nums">${esc(i.line)}</div></div>`).join('')}</div>` : ''}
    <div class="space-y-1 text-xs">${v.summary.map((s) => `<div class="flex justify-between ${s.strong ? 'font-semibold text-ink-primary border-t border-line-subtle pt-1.5' : 'text-ink-secondary'}"><span>${esc(s.label)}</span><span class="tabular-nums">${esc(s.value)}</span></div>`).join('')}</div>
    ${v.contact.length ? `<div><div class="type-small font-semibold mb-1">Contact</div>${v.contact.map((c) => `<div class="text-xs text-ink-secondary break-all">${esc(c)}</div>`).join('')}</div>` : ''}
    <div class="grid grid-cols-2 gap-3"><div><div class="type-small font-semibold mb-1">Ship to</div>${addr(v.shippingAddress)}</div><div><div class="type-small font-semibold mb-1">Bill to</div>${addr(v.billingAddress)}</div></div>
    ${v.shipments.map((s) => `<div class="p-2.5 rounded-md border border-line-subtle text-xs"><div class="font-semibold">${esc(s.status)}</div><div class="text-ink-secondary">${[s.shipped && `Shipped ${esc(s.shipped)}`, s.expected && `Expected ${esc(s.expected)}`, s.delivered && `Delivered ${esc(s.delivered)}`].filter(Boolean).join(' · ')}</div>${(s.tracking || []).map((t) => `<div class="text-ink-muted">${esc(t.company || '')} ${t.url ? `<a class="text-accent underline" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${esc(t.number || 'Track')}</a>` : esc(t.number || '')}</div>`).join('')}</div>`).join('')}
  </div>`, `${v.conversationId ? `<button type="button" data-action="open-chat" data-id="${esc(v.conversationId)}" class="px-3 py-2 rounded-md text-xs font-medium border border-line-subtle hover:bg-subtle">Open the chat</button>` : ''}${v.shopifyUrl ? `<a href="${esc(v.shopifyUrl)}" target="_top" class="px-3 py-2 rounded-md text-xs font-medium bg-accent-gradient text-white">Open in Shopify</a>` : ''}`);
};

/** Calls, AI voice sessions, complaints and callbacks on one customer's page, and how sure we are who they are. */
function customerCallsSection(data, id, p) {
  const c = data.calls;
  const note = data.person.identity === 'shopify' ? '' : '<div class="text-[11px] text-ink-muted mt-1">Not signed in: only this browser is recognised. If they clear their cookies or use another device they will appear as a new visitor until they sign in.</div>';
  const rows = (c?.calls || []).slice(0, 10).map((x) => callRow(x, {timezone: state.store.timezone}));
  const calls = c ? `<div><div class="flex items-center justify-between mb-1.5"><div class="type-small font-semibold">Calls</div>${c.human.total ? `<button type="button" data-action="person-calls" data-id="${esc(id)}" data-name="${esc(p.who)}" class="text-[11px] text-accent hover:underline">See all</button>` : ''}</div>
      <div class="grid grid-cols-3 gap-2 text-center text-xs mb-2"><div class="rounded-md border border-line-subtle p-2"><div class="font-semibold tabular-nums">${c.human.total}</div><div class="text-ink-muted">Human calls</div></div><div class="rounded-md border border-line-subtle p-2"><div class="font-semibold tabular-nums">${c.human.completed}</div><div class="text-ink-muted">Completed</div></div><div class="rounded-md border border-line-subtle p-2"><div class="font-semibold tabular-nums">${c.ai.sessions}</div><div class="text-ink-muted">AI voice sessions</div></div></div>
      <div class="text-[11px] text-ink-muted mb-2">Missed ${c.human.missed} · Failed ${c.human.failed} · Cancelled ${c.human.cancelled} · Talk time ${esc(duration(c.human.totalDurationSec))} (avg ${esc(duration(c.human.avgDurationSec))})</div>
      ${rows.length ? `<div class="rounded-md border border-line-subtle divide-y divide-line-subtle">${rows.map((r) => `<button type="button" data-action="open-call" data-id="${esc(r.id)}" class="w-full p-2.5 text-xs text-left hover:bg-subtle"><div class="flex items-center justify-between gap-2"><span class="font-medium text-ink-primary">${esc(r.when)}</span>${pill(r.outcome, r.tone)}</div><div class="text-ink-muted">Handled by ${esc(r.handler)}${r.duration !== '—' ? ` · ${esc(r.duration)}` : ''}</div></button>`).join('')}</div>` : '<div class="text-xs text-ink-muted">No calls with a person yet.</div>'}</div>` : '';
  const complaints = (data.complaints || []).length ? `<div><div class="type-small font-semibold mb-1.5">Complaints</div><div class="rounded-md border border-line-subtle divide-y divide-line-subtle">${data.complaints.map((x) => `<div class="p-2.5 text-xs"><span class="font-mono text-accent">${esc(x.reference)}</span> · ${esc(x.status.replace(/_/g, ' '))}<div class="text-ink-muted">${esc(x.summary)}</div></div>`).join('')}</div></div>` : '';
  const callbacks = (data.callbacks || []).length ? `<div><div class="type-small font-semibold mb-1.5">Callback requests</div><div class="text-[11px] text-ink-muted mb-1">A callback is a call booked for later. It is not counted as a call until someone talks.</div><div class="rounded-md border border-line-subtle divide-y divide-line-subtle">${data.callbacks.map((b) => `<div class="p-2.5 text-xs flex justify-between gap-2"><span>${esc(formatWhen(b.startAt, state.store.timezone))}</span><span class="text-ink-muted">${esc(b.status || '')}</span></div>`).join('')}</div></div>` : '';
  return `${note ? `<div>${note}</div>` : ''}${calls}${complaints}${callbacks}`;
}

actions['open-customer'] = async (el) => {
  const id = el.getAttribute('data-id');
  openDrawer('Customer', '<div class="text-xs text-ink-muted">Loading…</div>');
  let data;
  try {
    data = await getCustomer(id);
  } catch (error) {
    // e.g. a customer whose chats were deleted: their calls remain as counts only
    openDrawer('Customer', `<div class="text-xs text-ink-secondary">${error instanceof ApiError && error.status === 404 ? 'No chats are saved for this customer any more (they may have been deleted), so there is no profile to show.' : 'This customer could not be loaded. Try again.'}</div>`);
    return;
  }
  const p = customerRow(data.person, {timezone: state.store.timezone});
  openDrawer(esc(p.who), `<div class="space-y-4">
    <div><div class="flex flex-wrap gap-1.5">${pill(p.kind, TONE[p.kindTone] || 'neutral')}${p.needsFollowUp ? pill('Needs follow-up', 'warning') : ''}</div>
      <div class="text-xs text-ink-secondary mt-2">${esc(p.detail || 'No contact details saved')}</div><div class="text-xs text-ink-muted mt-1">${esc(customerSummary(data.person))} · spent ${esc(p.spend)} · first seen ${esc(p.firstSeen)}</div></div>
    ${customerCallsSection(data, id, p)}
    <div><div class="type-small font-semibold mb-1.5">Orders</div>${data.orders.length ? `<div class="rounded-md border border-line-subtle divide-y divide-line-subtle">${data.orders.map((o) => `<button type="button" data-action="open-order" data-name="${esc(o.orderName || '')}" class="w-full p-2.5 flex justify-between text-xs text-left hover:bg-subtle"><span class="font-mono text-accent">${esc(o.orderName || 'Order')}</span><span class="tabular-nums">${esc(orderTotal(o))}</span></button>`).join('')}</div>` : '<div class="text-xs text-ink-muted">No orders yet.</div>'}</div>
    <div><div class="type-small font-semibold mb-1.5">Chats</div><div class="rounded-md border border-line-subtle divide-y divide-line-subtle">${data.conversations.map((c) => { const r = chatRow(c, {timezone: state.store.timezone}); return `<button type="button" data-action="open-chat" data-id="${esc(c.id)}" class="w-full p-2.5 text-left hover:bg-subtle"><div class="flex justify-between gap-2 text-xs"><span class="font-medium text-ink-primary truncate">${esc(r.preview)}</span><span class="text-ink-muted shrink-0">${esc(r.when)}</span></div><div class="mt-1 flex gap-1">${pill(r.state.label, TONE[r.state.tone] || 'neutral')}${pill(r.result, TONE[r.resultTone] || 'neutral')}</div></button>`; }).join('')}</div></div>
  </div>`, `<button type="button" data-action="ask-erase" data-id="${esc(id)}" data-name="${esc(p.who)}" class="px-3 py-2 rounded-md text-xs font-medium border border-danger text-danger-text hover:bg-danger-soft flex items-center gap-1.5"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i>Delete personal data</button>`);
};

actions['ask-erase'] = (el) => {
  const id = el.getAttribute('data-id');
  openModal('Delete personal data?', `<p class="type-body text-ink-secondary">This removes ${esc(el.getAttribute('data-name'))}'s chat transcripts, name, email, phone and call requests. Counts such as "a chat happened" and "an order was placed" stay, because they say nothing about who it was. This cannot be undone.</p>`,
    `<button type="button" data-action="close-modal" class="px-3 py-2 rounded-md text-xs font-medium border border-line-subtle hover:bg-subtle">Keep</button><button type="button" data-action="erase" data-id="${esc(id)}" class="px-3 py-2 rounded-md text-xs font-medium bg-danger text-white">Delete for good</button>`);
};
actions['erase'] = async (el) => {
  const done = await erasePerson(el.getAttribute('data-id'));
  closeModal();
  closeDrawer();
  toast('Personal data deleted', `${done.messages} messages and ${done.bookings} call requests removed.`);
  const {show} = await import('../app.js');
  await show('orders');
};

document.addEventListener('input', debounce(async (e) => {
  if (!(e.target instanceof HTMLElement)) return;
  if (e.target.id === 'oc-search-input') {
    ui.q = e.target.value.trim();
    const r = await rangeNow();
    await (ui.tab === 'orders' ? fetchOrders(r) : fetchCustomers(r)).catch((err) => toast('Search failed', err instanceof ApiError ? err.message : '', 'danger'));
    await redraw();
    const el = document.getElementById('oc-search-input');
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }
}, 350));
document.addEventListener('change', async (e) => {
  if (e.target instanceof HTMLElement && e.target.id === 'oc-sort') {
    ui.sort = e.target.value;
    await fetchCustomers(await rangeNow());
    await redraw();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target instanceof HTMLElement && e.target.matches('tr[data-action]')) e.target.click();
});
