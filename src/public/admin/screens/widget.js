// Widget: the chat bubble on the storefront is a Shopify theme app embed, so it is switched on in the theme editor.
// This page gets the owner there with one click and shows how much the widget is used (counted, not guessed).
import {screens, state} from '../core.js';
import {getOverview} from '../api.js';
import {formatNumber} from '../lib/format.js';
import {esc} from '../ui.js';

const EMBED_HANDLE = 'ai_chat_widget';
const apiKey = () => document.querySelector('meta[name="shopify-api-key"]')?.content || '';
const storeHandle = () => state.store.shop.replace(/\.myshopify\.com$/, '');

screens.widget = {
  load: ({range}) => getOverview(range),
  html(o) {
    const editor = `https://admin.shopify.com/store/${encodeURIComponent(storeHandle())}/themes/current/editor?context=apps&activateAppId=${encodeURIComponent(apiKey())}/${EMBED_HANDLE}`;
    const t = o.totals;
    const steps = [
      'Open the theme editor with the button below. The app embed "AI Chat Widget" is switched on for you to review.',
      'Check that it is on, and (if asked) that the Chat backend URL is your assistant server.',
      'Press Save in the theme editor. The chat bubble then appears on every page of your store.',
      'Open your store in a new tab and send a message to test it. The chat will show up under Conversations.',
    ];
    return `<div class="space-y-5"><div><h1 class="type-h1">Widget</h1><p class="type-body text-ink-secondary">The chat bubble your shoppers see on your storefront.</p></div>
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <section class="lg:col-span-7 p-5 rounded-lg border border-line-subtle bg-surface shadow-xs space-y-4"><h2 class="type-h2">Switch it on</h2>
          <ol class="space-y-3">${steps.map((s, i) => `<li class="flex gap-3 text-xs text-ink-secondary"><span class="w-5 h-5 rounded-full bg-accent-soft text-accent-text text-[11px] font-semibold flex items-center justify-center shrink-0">${i + 1}</span><span>${esc(s)}</span></li>`).join('')}</ol>
          <div class="flex flex-wrap gap-2"><a href="${esc(editor)}" target="_top" class="px-3.5 py-2 rounded-md text-xs font-medium bg-accent-gradient text-white shadow-xs inline-flex items-center gap-1.5"><i data-lucide="external-link" class="w-3.5 h-3.5"></i>Open the theme editor</a>
            <a href="https://${esc(state.store.shop)}" target="_blank" rel="noopener noreferrer" class="px-3.5 py-2 rounded-md text-xs font-medium border border-line-subtle hover:bg-subtle inline-flex items-center gap-1.5"><i data-lucide="store" class="w-3.5 h-3.5"></i>Open your store</a></div>
          <p class="text-[11px] text-ink-muted">How it looks and which pages it appears on are set in the theme editor, under App embeds.</p></section>
        <section class="lg:col-span-5 p-5 rounded-lg border border-line-subtle bg-surface shadow-xs space-y-3"><h2 class="type-h2">Use in this period</h2><p class="type-caption text-ink-secondary">${esc(o.range.from)} to ${esc(o.range.to)}</p>
          <div class="grid grid-cols-2 gap-3"><div class="p-3 rounded-md bg-subtle/50"><div class="text-[11px] text-ink-muted">Chats</div><div class="type-h1 tabular-nums">${formatNumber(t.conversations)}</div></div><div class="p-3 rounded-md bg-subtle/50"><div class="text-[11px] text-ink-muted">Visitors who chatted</div><div class="type-h1 tabular-nums">${formatNumber(t.visitors)}</div></div>
            <div class="p-3 rounded-md bg-subtle/50"><div class="text-[11px] text-ink-muted">Text chats</div><div class="type-h1 tabular-nums">${formatNumber(t.channels?.text)}</div></div><div class="p-3 rounded-md bg-subtle/50"><div class="text-[11px] text-ink-muted">Voice chats</div><div class="type-h1 tabular-nums">${formatNumber(t.channels?.voice)}</div></div></div>
          ${t.conversations ? '<p class="text-xs text-success-text">Shoppers are using the widget.</p>' : '<p class="text-xs text-warning-text">No chats yet in this period. If the widget is on, send a test message from your store.</p>'}</section>
      </div></div>`;
  },
};
