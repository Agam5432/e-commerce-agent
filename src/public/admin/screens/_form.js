// The settings form shared by "Train your assistant" and "Settings": one copy of the saved settings, one draft the
// owner edits, and one Save bar. Fields are wired by data attributes, so typing never redraws the page (and never
// loses the cursor).
import {state} from '../core.js';
import {ApiError, getSettings, getSettingsHistory, saveSettings} from '../api.js';
import {isDirty, tabForError, toForm, toPatch, validateForm} from '../lib/settingsForm.js';
import {esc, toast} from '../ui.js';
import {refreshSupport} from '../support.js';

export const sf = {loaded: false, settings: {}, options: {}, form: null, saved: null, history: [], errors: {}, saving: false};

export async function loadSettings() {
  const [res, hist] = await Promise.all([getSettings(), getSettingsHistory().catch(() => ({history: []}))]);
  sf.settings = res.settings || {};
  sf.options = res.options || {};
  sf.form = toForm(sf.settings, sf.options);
  sf.saved = toForm(sf.settings, sf.options);
  sf.history = hist.history || [];
  sf.errors = {};
  sf.loaded = true;
}

export const dirty = () => Boolean(sf.form) && isDirty(sf.form, sf.saved);

// ---- small builders ---------------------------------------------------------------------------------
const err = (key) => (sf.errors[key] ? `<p class="text-[11px] text-danger-text mt-1" role="alert">${esc(sf.errors[key])}</p>` : '');
const box = 'w-full px-3 py-2 text-xs rounded-md border border-line-subtle bg-subtle/40 focus-ring';

export const card = (title, hint, inner) => `<section class="p-5 rounded-lg border border-line-subtle bg-surface shadow-xs space-y-3"><div><h2 class="type-h2">${esc(title)}</h2>${hint ? `<p class="type-caption text-ink-secondary">${esc(hint)}</p>` : ''}</div>${inner}</section>`;

export function text(field, label, {hint = '', max = 0, multiline = false, placeholder = '', type = 'text'} = {}) {
  const v = sf.form[field];
  const input = multiline
    ? `<textarea data-field="${field}" rows="5" ${max ? `maxlength="${max + 200}"` : ''} placeholder="${esc(placeholder)}" class="${box}">${esc(v)}</textarea>`
    : `<input data-field="${field}" type="${type}" value="${esc(v)}" placeholder="${esc(placeholder)}" class="${box}" />`;
  return `<label class="block text-xs font-medium text-ink-primary">${esc(label)}${input}${hint ? `<span class="block text-[11px] text-ink-muted font-normal mt-1">${esc(hint)}${max ? ` <span data-count-for="${field}">${v.length}/${max}</span>` : ''}</span>` : ''}${err(field)}</label>`;
}

export function toggle(field, label, details = '') {
  return `<label class="flex items-start gap-3 py-2 cursor-pointer"><input type="checkbox" data-field="${field}" ${sf.form[field] ? 'checked' : ''} class="mt-0.5 w-4 h-4 accent-[var(--accent-primary)]" /><span><span class="block text-xs font-medium text-ink-primary">${esc(label)}</span>${details ? `<span class="block text-[11px] text-ink-muted">${esc(details)}</span>` : ''}</span></label>`;
}

export function select(field, label, choices, {number = false, hint = ''} = {}) {
  const cur = String(sf.form[field]);
  return `<label class="block text-xs font-medium text-ink-primary">${esc(label)}<select data-field="${field}" ${number ? 'data-number="1"' : ''} class="${box} mt-1">${choices.map((c) => {
    const [value, name] = Array.isArray(c) ? c : [c, c];
    return `<option value="${esc(value)}" ${String(value) === cur ? 'selected' : ''}>${esc(name)}</option>`;
  }).join('')}</select>${hint ? `<span class="block text-[11px] text-ink-muted font-normal mt-1">${esc(hint)}</span>` : ''}${err(field)}</label>`;
}

export function saveBar() {
  const on = dirty();
  return `<div id="save-bar" class="sticky bottom-3 z-10 mt-4 p-3 rounded-lg border border-line-strong bg-surface shadow-md flex items-center justify-between gap-3"><span class="text-xs ${on ? 'text-warning-text font-medium' : 'text-ink-muted'}">${on ? 'You have unsaved changes' : 'All changes saved'}</span><div class="flex gap-2"><button type="button" data-action="settings-discard" ${on ? '' : 'disabled'} class="px-3 py-2 rounded-md text-xs font-medium border border-line-subtle hover:bg-subtle disabled:opacity-50">Discard</button><button type="button" data-action="settings-save" ${on && !sf.saving ? '' : 'disabled'} class="px-3.5 py-2 rounded-md text-xs font-medium bg-accent-gradient text-white shadow-xs disabled:opacity-50">${sf.saving ? 'Saving…' : 'Save changes'}</button></div></div>`;
}

// ---- wiring (once) ------------------------------------------------------------------------------------
function refreshBar() {
  const bar = document.getElementById('save-bar');
  if (bar) bar.outerHTML = saveBar();
}

function setField(el) {
  const field = el.dataset.field;
  if (!field || !sf.form) return;
  if (el instanceof HTMLInputElement && el.type === 'checkbox') sf.form[field] = el.checked;
  else sf.form[field] = el.dataset.number ? Number(el.value) : el.value;
  const counter = document.querySelector(`[data-count-for="${field}"]`);
  if (counter) counter.textContent = `${String(sf.form[field]).length}/${counter.textContent.split('/')[1]}`;
  refreshBar();
}

document.addEventListener('input', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLElement) || !sf.form) return;
  if (el.dataset.field && !(el instanceof HTMLSelectElement) && !(el instanceof HTMLInputElement && el.type === 'checkbox')) setField(el);
  if (el.dataset.kq !== undefined) { sf.form.knowledge[Number(el.dataset.kq)].question = el.value; refreshBar(); }
  if (el.dataset.ka !== undefined) { sf.form.knowledge[Number(el.dataset.ka)].answer = el.value; refreshBar(); }
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLElement) || !sf.form) return;
  if (el.dataset.field && (el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && el.type === 'checkbox'))) setField(el);
  if (el.dataset.day !== undefined) {
    const day = Number(el.dataset.day);
    const set = new Set(sf.form.callDays);
    if (el.checked) set.add(day); else set.delete(day);
    sf.form.callDays = [...set].sort((a, b) => a - b);
    // the day is a chip whose look is drawn from the form: show the change now, not only after Save
    const chip = el.closest('label');
    if (chip) {
      for (const c of ['border-accent', 'bg-accent-soft', 'text-accent-text']) chip.classList.toggle(c, el.checked);
      for (const c of ['border-line-subtle', 'text-ink-secondary']) chip.classList.toggle(c, !el.checked);
      chip.setAttribute('aria-pressed', String(el.checked));
    }
    refreshBar();
  }
  if (el.dataset.toolGroup !== undefined) {
    const tools = el.dataset.toolGroup.split(',');
    const off = new Set(sf.form.disabledTools);
    for (const t of tools) { if (el.checked) off.delete(t); else off.add(t); }
    sf.form.disabledTools = [...off].sort();
    refreshBar();
  }
});

async function redraw() {
  (await import('../app.js')).redraw();
}

export const settingsActions = {
  'settings-discard': async () => {
    sf.form = toForm(sf.settings, sf.options);
    sf.errors = {};
    await redraw();
  },
  'settings-save': async () => {
    sf.errors = validateForm(sf.form);
    if (Object.keys(sf.errors).length) {
      const first = Object.keys(sf.errors)[0];
      toast('Fix the highlighted fields', 'Nothing was saved.', 'warning');
      const wanted = tabForError(first);
      const screen = ['behaviour', 'knowledge'].includes(wanted) ? 'train' : 'settings';
      // the draft and the errors live in `sf`, so opening the other screen shows them there
      if (state.screen !== screen) await (await import('../app.js')).show(screen);
      else await redraw();
      return;
    }
    sf.saving = true;
    refreshBar();
    try {
      const res = await saveSettings(toPatch(sf.form), sf.settings.version ?? 0);
      await loadSettings();
      refreshSupport();
      toast(res.changed?.length ? 'Saved' : 'Nothing changed', res.changed?.length ? 'Your assistant uses this from its next reply.' : '', res.changed?.length ? 'success' : 'warning');
    } catch (error) {
      toast('Could not save', error instanceof ApiError && error.status === 409 ? 'Someone else changed these settings a moment ago. Your draft is kept; reload to see theirs.' : error instanceof ApiError ? error.message : 'Try again.', 'danger');
      if (error instanceof ApiError && error.details?.errors) sf.errors = {};
    } finally {
      sf.saving = false;
    }
    await redraw();
  },
};
