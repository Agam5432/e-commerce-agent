// The dashboard's entry point: loads the store, draws the frame (sidebar, top bar), opens screens and routes clicks.
import {NAV, PERIODS, actions, range, screens, state, wideRange} from './core.js';
import {ApiError, getAttention, getConversations, getMe} from './api.js';
import {closeDrawer, closeModal, debounce, emptyState, errorState, esc, icons, skeleton, toast} from './ui.js';
import './screens/home.js';
import './screens/conversations.js';
import './screens/orders.js';
import './screens/bookings.js';
import './screens/complaints.js';
import './screens/calls.js';
import './screens/insights.js';
import './screens/train.js';
import './screens/widget.js';
import './screens/settings.js';
import {initSupport, supportActions} from './support.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private window: the choice is simply not remembered */ }
  },
};

// ---- theme and sidebar ----------------------------------------------------------------------------
function applyTheme(dark) {
  document.documentElement.classList.toggle('dark', dark);
  $('theme-icon')?.setAttribute('data-lucide', dark ? 'sun' : 'moon');
  icons();
}

// ---- the frame ------------------------------------------------------------------------------------
function badge(kind) {
  const a = state.attention;
  if (!a) return 0;
  return kind === 'unread' ? a.inbox?.unread || 0 : kind === 'todo' ? a.todo || 0 : kind === 'calls' ? a.calls?.waiting || 0 : kind === 'complaints' ? a.complaints?.open || 0 : 0;
}

export function renderNav() {
  $('sidebar-nav').innerHTML = NAV.map((item) => {
    const active = state.screen === item.id;
    const n = item.badge ? badge(item.badge) : 0;
    return `<button type="button" data-nav="${item.id}" class="w-full flex items-center justify-between px-2.5 py-2 rounded-md text-xs font-medium transition-colors focus-ring ${active ? 'bg-accent-soft text-accent-text font-semibold' : 'text-ink-secondary hover:bg-subtle hover:text-ink-primary'}" title="${esc(item.label)}"${active ? ' aria-current="page"' : ''}>
      <span class="flex items-center gap-2.5 min-w-0"><i data-lucide="${item.icon}" class="w-4 h-4 shrink-0 ${active ? 'text-accent' : ''}"></i><span class="sidebar-label truncate">${esc(item.label)}</span></span>
      ${n ? `<span class="sidebar-label px-1.5 py-0.5 text-[10px] font-bold rounded-pill bg-danger text-white tabular-nums">${n}</span>` : ''}
    </button>`;
  }).join('');
  const primary = ['home', 'conversations', 'orders', 'train'];
  $('mobile-tab-bar').innerHTML = primary.map((id) => {
    const item = NAV.find((n) => n.id === id);
    const active = state.screen === id;
    return `<button type="button" data-nav="${id}" class="flex flex-col items-center justify-center py-1 px-2 text-[11px] ${active ? 'text-accent font-semibold' : 'text-ink-secondary'}"><i data-lucide="${item.icon}" class="w-4 h-4 mb-0.5"></i><span>${esc(item.label.split(' ')[0])}</span></button>`;
  }).join('') + `<button type="button" data-action="mobile-more" class="flex flex-col items-center justify-center py-1 px-2 text-[11px] text-ink-secondary"><i data-lucide="menu" class="w-4 h-4 mb-0.5"></i><span>More</span></button>`;
  document.querySelectorAll('.sidebar-label').forEach((el) => { el.style.display = state.sidebarCollapsed ? 'none' : ''; });
  $('app-sidebar').classList.toggle('w-16', state.sidebarCollapsed);
  $('app-sidebar').classList.toggle('w-60', !state.sidebarCollapsed);
}

function renderPeriod() {
  document.querySelectorAll('.period-btn').forEach((b) => {
    const on = b.dataset.period === state.period;
    b.className = `period-btn px-2.5 py-1 rounded-sm text-xs font-medium ${on ? 'bg-surface text-ink-primary shadow-xs' : 'text-ink-secondary hover:text-ink-primary'} ${b.dataset.period === 'custom' ? 'flex items-center gap-1' : ''}`;
  });
  const pick = $('period-select');
  if (pick && state.period !== 'custom') pick.value = state.period;
  const r = range();
  $('custom-date-label').textContent = state.period === 'custom' ? `${r.from} – ${r.to}` : 'Custom';
}

function renderStore() {
  const s = state.store;
  $('store-name').textContent = s.name || s.shop;
  $('store-domain').textContent = s.shop;
  $('store-initials').textContent = (s.name || s.shop || '··').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

/** Alerts the owner has not seen yet, made from what is waiting right now. */
function alerts() {
  const a = state.attention;
  const list = [];
  // Shopify refused this store's access: shoppers cannot be helped until the app is opened again from Shopify admin.
  if (state.store?.reauthRequired) list.push({id: 'reauth', n: 1, title: 'Shopify access stopped working. Open this app again from your Shopify admin (or reinstall it) so the assistant can serve shoppers.', screen: 'home'});
  if (!a) return list;
  if (a.calls?.waiting) list.push({id: 'calls', n: a.calls.waiting, title: `${a.calls.waiting} call ${a.calls.waiting === 1 ? 'request is' : 'requests are'} waiting for you`, screen: 'bookings'});
  if (a.inbox?.waiting) list.push({id: 'waiting', n: a.inbox.waiting, title: `${a.inbox.waiting} ${a.inbox.waiting === 1 ? 'chat is' : 'chats are'} waiting on you`, screen: 'conversations'});
  if (a.files) list.push({id: 'files', n: a.files, title: `${a.files} ${a.files === 1 ? 'chat has' : 'chats have'} files from shoppers`, screen: 'conversations'});
  return list;
}

function renderAlerts() {
  const seen = JSON.parse(store.get(`orbi-seen-${state.store.shop}`) || '{}');
  const list = alerts().map((x) => ({...x, unread: (seen[x.id] || 0) < x.n}));
  $('notif-dot').style.display = list.some((x) => x.unread) ? 'block' : 'none';
  $('notif-list').innerHTML = list.length
    ? list.map((x) => `<button type="button" data-nav="${x.screen}" class="w-full text-left p-2 rounded hover:bg-subtle flex items-start justify-between gap-2"><div class="font-medium text-ink-primary">${esc(x.title)}</div>${x.unread ? '<span class="w-2 h-2 rounded-full bg-accent shrink-0 mt-1"></span>' : ''}</button>`).join('')
    : '<div class="p-2 text-ink-muted">Nothing is waiting for you.</div>';
  state.alertCounts = Object.fromEntries(list.map((x) => [x.id, x.n]));
}

async function refreshAttention() {
  try {
    state.attention = await getAttention();
  } catch { /* the sidebar numbers just stay as they were */ }
  renderNav();
  renderAlerts();
  icons();
}

// ---- screens ---------------------------------------------------------------------------------------
let ticket = 0;
export async function show(id, { silent = false } = {}) {
  if (!screens[id]) id = 'home';
  const mine = ++ticket;
  state.screen = id;
  try { history.replaceState(null, '', `#/${id}`); } catch { /* embedded frames may refuse */ }
  renderNav();
  renderPeriod();
  const box = $('screen-container');
  if (!silent) {
    box.innerHTML = skeleton();
    $('page-title')?.replaceChildren();
  }
  try {
    const data = await screens[id].load({state, range: range()});
    if (mine !== ticket) return;
    state.view = {status: 'ready', data};
    box.innerHTML = screens[id].html(data, {state, range: range()});
  } catch (error) {
    if (mine !== ticket) return;
    console.error('[dashboard]', error);
    state.view = {status: 'error', error};
    box.innerHTML = errorState(error instanceof ApiError ? error.message : 'Something went wrong. Try again.');
  }
  icons();
  if (mine === ticket) screens[id].after?.(state.view.data, {state, range: range()});
}

/** Draw the current screen again from data already loaded (no new request). */
export function redraw() {
  const s = screens[state.screen];
  if (state.view.status !== 'ready') return;
  $('screen-container').innerHTML = s.html(state.view.data, {state, range: range()});
  icons();
  s.after?.(state.view.data, {state, range: range()});
}
export const reload = () => show(state.screen, {silent: true});

// ---- global click handling --------------------------------------------------------------------------
actions['retry'] = () => show(state.screen);
Object.assign(actions, supportActions);
actions['mobile-more'] = () => {
  const rest = NAV.filter((n) => !['home', 'conversations', 'orders', 'train'].includes(n.id));
  import('./ui.js').then(({openModal}) => {
    openModal('More', `<div class="space-y-1">${rest.map((n) => `<button type="button" data-nav="${n.id}" class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm text-ink-secondary hover:bg-subtle"><i data-lucide="${n.icon}" class="w-4 h-4"></i>${esc(n.label)}</button>`).join('')}</div>`);
  });
};

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;

  const nav = t.closest('[data-nav]');
  if (nav) {
    closeModal();
    closeDrawer();
    $('notif-popover').classList.add('hidden');
    closeCommandPalette();
    show(nav.getAttribute('data-nav'));
    return;
  }
  const period = t.closest('[data-period]');
  if (period) {
    const id = period.getAttribute('data-period');
    if (id === 'custom') return openCustomRange();
    state.period = id;
    store.set('orbi-period', id);
    renderPeriod();
    if (['home', 'quality', 'catalog', 'orders', 'conversations', 'widget'].includes(state.screen)) show(state.screen);
    return;
  }
  const act = t.closest('[data-action]');
  if (act) {
    const run = actions[act.getAttribute('data-action')];
    if (run) {
      e.preventDefault();
      Promise.resolve(run(act, e)).catch((error) => {
        console.error('[dashboard]', error);
        toast('That did not work', error instanceof ApiError ? error.message : 'Try again.', 'danger');
      });
    }
    return;
  }
  if (t.closest('#close-drawer-btn') || t.id === 'drawer-backdrop') return closeDrawer();
  if (t.closest('#close-modal-btn') || t.id === 'modal-backdrop') return closeModal();
  if (t.closest('#collapse-sidebar-btn')) {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    store.set('orbi-collapsed', state.sidebarCollapsed ? '1' : '');
    return renderNav(), icons();
  }
  if (t.closest('#toggle-theme-btn')) {
    const dark = !document.documentElement.classList.contains('dark');
    store.set('orbi-dark', dark ? '1' : '0');
    return applyTheme(dark);
  }
  if (t.closest('#toggle-notif-btn')) {
    $('notif-popover').classList.toggle('hidden');
    return;
  }
  if (t.closest('#mark-notif-read-btn')) {
    store.set(`orbi-seen-${state.store.shop}`, JSON.stringify(state.alertCounts || {}));
    return renderAlerts();
  }
  if (t.closest('#open-cmd-palette-btn')) return openCommandPalette();
  if (t.closest('#close-cmd-palette-btn') || t.id === 'cmd-palette-backdrop') return closeCommandPalette();
  if (t.closest('#open-help-modal-btn')) {
    import('./ui.js').then(({openModal}) => openModal('Help', '<p class="type-body text-ink-secondary">Open a chat from Conversations to read it, take it over from the AI, or hand it back. Everything on these screens is counted from your store\'s real chats and orders.</p>'));
    return;
  }
  const cmd = t.closest('.cmd-result-item');
  if (cmd) {
    closeCommandPalette();
    const go = cmd.dataset;
    if (go.cmdConv) {
      state.openConv = go.cmdConv;
      return show('conversations');
    }
    if (go.cmdNav) return show(go.cmdNav);
    return;
  }
  if (!t.closest('#notif-popover')) $('notif-popover')?.classList.add('hidden');
});

document.addEventListener('change', (e) => {
  if (!(e.target instanceof HTMLSelectElement) || e.target.id !== 'period-select') return;
  state.period = e.target.value;
  store.set('orbi-period', state.period);
  renderPeriod();
  if (['home', 'quality', 'catalog', 'orders', 'conversations', 'widget'].includes(state.screen)) show(state.screen);
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openCommandPalette();
  }
  if (e.key === 'Escape') {
    closeModal();
    closeDrawer();
    closeCommandPalette();
  }
});

// ---- search palette ---------------------------------------------------------------------------------
function openCommandPalette() {
  $('cmd-palette-backdrop').classList.remove('hidden');
  $('cmd-palette-input').value = '';
  paletteResults('');
  setTimeout(() => $('cmd-palette-input').focus(), 20);
}
function closeCommandPalette() {
  $('cmd-palette-backdrop').classList.add('hidden');
}
let paletteTicket = 0;
async function paletteResults(query) {
  const q = query.trim().toLowerCase();
  const mine = ++paletteTicket;
  const rows = NAV.filter((n) => !q || n.label.toLowerCase().includes(q)).map((n) => ({type: 'Screen', label: `Go to ${n.label}`, sub: '', nav: n.id}));
  const draw = (list) => {
    $('cmd-palette-results').innerHTML = list.length
      ? list.slice(0, 10).map((it) => `<button type="button" data-cmd-nav="${esc(it.nav || '')}" data-cmd-conv="${esc(it.conv || '')}" class="cmd-result-item w-full p-2.5 rounded-md hover:bg-subtle text-left text-xs flex items-center justify-between gap-3"><div class="min-w-0"><span class="px-1.5 py-0.5 text-[10px] rounded bg-accent-soft text-accent-text font-medium mr-1.5">${esc(it.type)}</span><span class="font-medium text-ink-primary">${esc(it.label)}</span></div><span class="text-[11px] text-ink-muted truncate max-w-[200px]">${esc(it.sub)}</span></button>`).join('')
      : emptyState('Nothing found', 'Try a name, an email or a screen.', 'search');
    icons();
  };
  draw(rows);
  if (q.length < 2) return;
  try {
    const found = await getConversations({q, limit: 6, ...wideRange()});
    if (mine !== paletteTicket) return;
    draw([...rows, ...found.items.map((c) => ({type: 'Chat', label: c.contact?.name || c.contact?.email || c.contact?.phone || 'Visitor', sub: c.firstMessage || '', conv: c.id}))]);
  } catch { /* the screens list is still shown */ }
}
$('cmd-palette-input')?.addEventListener('input', debounce((e) => paletteResults(e.target.value), 250));

function openCustomRange() {
  import('./ui.js').then(({openModal}) => {
    const r = range();
    openModal('Pick a date range', `<div class="grid grid-cols-2 gap-3"><label class="text-xs">From<input id="range-from" type="date" value="${esc(r.from)}" class="mt-1 w-full px-2 py-1.5 rounded-md border border-line-subtle bg-surface"/></label><label class="text-xs">To<input id="range-to" type="date" value="${esc(r.to)}" class="mt-1 w-full px-2 py-1.5 rounded-md border border-line-subtle bg-surface"/></label></div>`, '<button type="button" data-action="apply-range" class="px-3 py-2 rounded-md text-xs font-medium bg-accent-gradient text-white">Apply</button>');
  });
}
actions['apply-range'] = () => {
  const from = $('range-from').value;
  const to = $('range-to').value;
  if (!from || !to) return toast('Pick both dates', '', 'warning');
  if (from > to) return toast('The first date is after the last', '', 'warning');
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 >= 366) return toast('That is too long', 'Pick at most 366 days.', 'warning');
  state.period = 'custom';
  state.custom = {from, to};
  closeModal();
  renderPeriod();
  show(state.screen);
};

// ---- start ------------------------------------------------------------------------------------------
async function boot() {
  applyTheme(store.get('orbi-dark') === '1');
  state.sidebarCollapsed = store.get('orbi-collapsed') === '1';
  const saved = store.get('orbi-period');
  if (PERIODS.some((p) => p.id === saved && p.id !== 'custom')) state.period = saved;
  const wanted = location.hash.replace(/^#\//, '');
  const first = screens[wanted] ? wanted : 'home';
  try {
    const me = await getMe();
    Object.assign(state.store, {shop: me.shop, name: me.name, currency: me.currency, timezone: me.timezone, industry: me.industry, reauthRequired: Boolean(me.reauthRequired)});
  } catch (error) {
    $('screen-container').innerHTML = errorState(error instanceof ApiError ? error.message : 'Open this app from your Shopify admin.');
    renderNav();
    icons();
    return;
  }
  renderStore();
  await Promise.all([refreshAttention(), show(first)]);
  initSupport();
  setInterval(() => { if (!document.hidden) refreshAttention(); }, 60_000);
}
boot();
