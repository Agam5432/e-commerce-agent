// Train your assistant: its name and tone, extra instructions, and the questions you have answered once for good.
import {actions, screens, state} from '../core.js';
import {describeChange, LIMITS, TONES} from '../lib/settingsForm.js';
import {formatWhen} from '../lib/format.js';
import {emptyState, esc} from '../ui.js';
import {card, loadSettings, saveBar, settingsActions, sf, text} from './_form.js';

Object.assign(actions, settingsActions);

async function redraw() {
  (await import('../app.js')).redraw();
}

function knowledge() {
  const rows = sf.form.knowledge;
  const inputCls = 'w-full px-3 py-2 text-xs rounded-md border border-line-subtle bg-subtle/40 focus-ring';
  return `<div class="space-y-3">${rows.length ? rows.map((k, i) => `<div class="p-3 rounded-md border border-line-subtle space-y-2">
      <div class="flex items-center justify-between"><span class="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Question ${i + 1}</span><button type="button" data-action="qa-remove" data-i="${i}" class="text-[11px] text-danger-text hover:underline">Remove</button></div>
      <label class="block text-xs">Shopper asks<input data-kq="${i}" value="${esc(k.question)}" maxlength="${LIMITS.question}" class="${inputCls} mt-1" />${sf.errors[`question-${i}`] ? `<p class="text-[11px] text-danger-text mt-1" role="alert">${esc(sf.errors[`question-${i}`])}</p>` : ''}</label>
      <label class="block text-xs">Assistant answers<textarea data-ka="${i}" rows="3" maxlength="${LIMITS.answer}" class="${inputCls} mt-1">${esc(k.answer)}</textarea>${sf.errors[`answer-${i}`] ? `<p class="text-[11px] text-danger-text mt-1" role="alert">${esc(sf.errors[`answer-${i}`])}</p>` : ''}</label></div>`).join('') : emptyState('No answers added yet', 'Add the questions shoppers keep asking, with the answer you want given.', 'book-open')}
    ${sf.errors.knowledge ? `<p class="text-[11px] text-danger-text" role="alert">${esc(sf.errors.knowledge)}</p>` : ''}
    <button type="button" data-action="qa-add" ${rows.length >= LIMITS.knowledge ? 'disabled' : ''} class="px-3 py-2 rounded-md text-xs font-medium border border-line-subtle hover:bg-subtle disabled:opacity-50">+ Add a question</button></div>`;
}

screens.train = {
  async load() {
    if (!sf.loaded) await loadSettings();
    return {};
  },
  html() {
    const toneChoices = [...new Set([...TONES, sf.form.tone].filter(Boolean))];
    return `<div class="space-y-5"><div><h1 class="type-h1">Train your assistant</h1><p class="type-body text-ink-secondary">How it talks and what it should know about your store. Products, prices, stock and policies always come live from Shopify.</p></div>
      ${card('How it talks', 'The name shoppers see and the way it speaks.', `<div class="grid grid-cols-1 md:grid-cols-2 gap-3">${text('name', 'Assistant name', {max: LIMITS.name, hint: `Leave empty for the default`, placeholder: sf.options.defaultAgentName || ''})}
        <div><label class="block text-xs font-medium text-ink-primary">Tone<select data-tone-pick class="w-full px-3 py-2 text-xs rounded-md border border-line-subtle bg-subtle/40 mt-1"><option value="">Default</option>${toneChoices.map((t) => `<option ${sf.form.tone === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label></div></div>
        ${text('tone', 'Or describe the tone in your own words', {max: LIMITS.tone, multiline: false})}
        ${text('instructions', 'Extra instructions', {max: LIMITS.instructions, multiline: true, hint: 'For example: "Never promise delivery dates." The assistant follows these on top of its safety rules.'})}`)}
      ${card('Questions and answers', 'When a shopper asks one of these, the assistant gives your answer.', knowledge())}
      ${card('Version history', 'The last changes made to these settings.', sf.history.length ? `<div class="divide-y divide-line-subtle">${sf.history.slice(0, 8).map((h) => `<div class="py-2 flex justify-between gap-3 text-xs"><span class="text-ink-primary">${esc(describeChange(h))}${h.by ? ` <span class="text-ink-muted">by ${esc(h.by)}</span>` : ''}</span><span class="text-ink-muted shrink-0">${esc(formatWhen(h.at, state.store.timezone))}</span></div>`).join('')}</div>` : '<p class="text-xs text-ink-muted">No changes yet.</p>')}
      ${saveBar()}</div>`;
  },
};

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el instanceof HTMLSelectElement && el.hasAttribute('data-tone-pick') && sf.form) {
    sf.form.tone = el.value;
    redraw();
  }
});
actions['qa-add'] = async () => {
  sf.form.knowledge.push({question: '', answer: ''});
  await redraw();
};
actions['qa-remove'] = async (el) => {
  sf.form.knowledge.splice(Number(el.getAttribute('data-i')), 1);
  sf.errors = {};
  await redraw();
};
