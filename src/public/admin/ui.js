// Small building blocks the screens share: safe text, toasts, the side drawer, the modal, loading/empty/error
// states and the sparkline. Everything a shopper wrote goes through esc() before it reaches the page.

/** Text safe to put inside HTML (also inside a quoted attribute). */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

const $ = (id) => document.getElementById(id);

export function icons() {
  if (globalThis.lucide) globalThis.lucide.createIcons({attrs: {'stroke-width': 1.75}});
}

export function toast(title, subtitle = '', tone = 'success') {
  const box = $('toast-container');
  if (!box) return;
  const icon = tone === 'danger' ? 'alert-triangle' : tone === 'warning' ? 'alert-circle' : 'check-circle-2';
  const color = tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-success';
  const el = document.createElement('div');
  el.className = 'pointer-events-auto flex items-start gap-2.5 p-3 rounded-md border shadow-md transition-all duration-150 bg-surface text-ink-primary border-line-strong';
  el.setAttribute('role', tone === 'danger' ? 'alert' : 'status');
  el.innerHTML = `<i data-lucide="${icon}" class="w-4 h-4 ${color} shrink-0 mt-0.5"></i><div class="text-xs"><div class="font-semibold">${esc(title)}</div>${subtitle ? `<div class="text-ink-secondary mt-0.5">${esc(subtitle)}</div>` : ''}</div>`;
  box.appendChild(el);
  icons();
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 180);
  }, tone === 'danger' ? 6000 : 3200);
}

function panel(prefix, title, body, footer) {
  $(`${prefix}-title`).textContent = title;
  $(`${prefix}-body`).innerHTML = body;
  const foot = $(`${prefix}-footer`);
  foot.innerHTML = footer || '';
  foot.style.display = footer ? 'flex' : 'none';
}

export function openDrawer(title, body, footer = '') {
  panel('drawer', title, body, footer);
  $('drawer-backdrop').classList.remove('hidden');
  $('side-drawer').classList.remove('hidden');
  icons();
}
export function closeDrawer() {
  $('drawer-backdrop').classList.add('hidden');
  $('side-drawer').classList.add('hidden');
}
export function openModal(title, body, footer = '') {
  panel('modal', title, body, footer);
  $('modal-backdrop').classList.remove('hidden');
  icons();
}
export function closeModal() {
  $('modal-backdrop').classList.add('hidden');
}

export const skeleton = (rows = 4) => `<div class="space-y-3 animate-pulse" aria-busy="true" aria-label="Loading">${Array.from({length: rows}, () => '<div class="h-16 rounded-lg bg-subtle"></div>').join('')}</div>`;

export function emptyState(title, text = '', icon = 'inbox') {
  return `<div class="py-12 text-center"><div class="mx-auto w-10 h-10 rounded-full bg-subtle flex items-center justify-center text-ink-muted"><i data-lucide="${icon}" class="w-5 h-5"></i></div><div class="type-h2 mt-3">${esc(title)}</div>${text ? `<p class="type-body text-ink-secondary mt-1 max-w-sm mx-auto">${esc(text)}</p>` : ''}</div>`;
}

export function errorState(message) {
  return `<div class="py-12 text-center" role="alert"><div class="mx-auto w-10 h-10 rounded-full bg-danger-soft flex items-center justify-center text-danger-text"><i data-lucide="alert-triangle" class="w-5 h-5"></i></div><div class="type-h2 mt-3">Could not load this</div><p class="type-body text-ink-secondary mt-1 max-w-sm mx-auto">${esc(message || 'Something went wrong.')}</p><button type="button" data-retry class="mt-4 px-3 py-2 rounded-md text-xs font-medium border border-line-subtle bg-surface hover:bg-subtle">Try again</button></div>`;
}

/** A small trend line for a KPI card. Needs at least two points; otherwise nothing is drawn. */
export function sparkline(points, color = '#4F46E5', id = '1') {
  const pts = (points || []).map(Number).filter(Number.isFinite);
  if (pts.length < 2) return '';
  const max = Math.max(...pts, 1);
  const min = Math.min(...pts, 0);
  const range = Math.max(max - min, 1);
  const w = 110;
  const h = 34;
  const coords = pts.map((v, i) => `${Math.round((i / (pts.length - 1)) * w)},${Math.round(h - ((v - min) / range) * (h - 8) - 4)}`);
  const line = `M ${coords.join(' L ')}`;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="overflow-visible" aria-hidden="true"><defs><linearGradient id="spark-${esc(id)}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity="0.26"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><path d="${line} L ${w},${h} L 0,${h} Z" fill="url(#spark-${esc(id)})"/><path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** A coloured pill. tone: success | warning | danger | accent | neutral */
export function pill(text, tone = 'neutral') {
  const cls = {success: 'bg-success-soft text-success-text', warning: 'bg-warning-soft text-warning-text', danger: 'bg-danger-soft text-danger-text', accent: 'bg-accent-soft text-accent-text', neutral: 'bg-subtle text-ink-secondary'}[tone] || 'bg-subtle text-ink-secondary';
  return `<span class="px-2 py-0.5 text-[10px] font-semibold rounded-pill ${cls}">${esc(text)}</span>`;
}

/** The product card shown under an AI reply. */
export function productCard(p) {
  const price = p.price ? `${esc(p.currency || '')} ${esc(p.price)}`.trim() : '';
  const was = p.compareAtPrice && Number(p.compareAtPrice) > Number(p.price) ? `<span class="text-[11px] text-ink-muted line-through">${esc(p.compareAtPrice)}</span>` : '';
  const img = p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" class="w-14 h-14 rounded-sm object-cover shrink-0 border border-line-subtle" />` : '<div class="w-14 h-14 rounded-sm bg-subtle shrink-0"></div>';
  const stock = p.inStock === false ? pill('Sold out', 'danger') : '';
  return `<div class="mt-2 p-2.5 rounded-md border border-line-subtle bg-surface text-ink-primary shadow-xs flex items-start gap-2.5 max-w-sm">${img}<div class="min-w-0 flex-1"><div class="text-xs font-semibold truncate">${esc(p.title)}</div><div class="flex items-baseline gap-1.5 mt-0.5 tabular-nums"><span class="text-xs font-bold">${price}</span>${was}</div>${stock ? `<div class="mt-1">${stock}</div>` : ''}</div></div>`;
}

export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
