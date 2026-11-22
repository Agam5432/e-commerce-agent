// The call window's start-up: swap the one-time ticket in the address for a session, then run the same call client the
// dashboard has (support.js). The ticket is read once and removed from the address bar and history.
import {configureConsole, initSupport, setPresence, supportActions, sup} from './support.js';
import {startHome} from './console-home.js';
import {unlockAudio} from './ring.js';
import {actions} from './core.js';
import {icons, toast} from './ui.js';

Object.assign(actions, supportActions);
// a click on a data-action button anywhere in this window runs it (the dashboard has the same one listener)
document.addEventListener('click', (e) => {
  const el = e.target instanceof Element ? e.target.closest('[data-action]') : null;
  const run = el && actions[el.getAttribute('data-action')];
  if (!run) return;
  e.preventDefault();
  Promise.resolve(run(el, e)).catch((error) => toast('That did not work', error?.message || 'Try again.', 'danger'));
});

const $ = (id) => document.getElementById(id);
const status = (text, bad = false) => { const el = $('console-status'); el.textContent = text; el.className = `text-xs ${bad ? 'text-danger-text' : 'text-ink-secondary'}`; };

async function start() {
  const ticket = new URLSearchParams(location.hash.slice(1)).get('ticket');
  history.replaceState(null, '', location.pathname);
  if (!ticket) return status('Open this window from the Calls button in your dashboard.', true);
  let session;
  try {
    const res = await fetch('/support-console/session', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ticket})});
    if (!res.ok) throw new Error('refused');
    session = await res.json();
  } catch {
    return status('This window could not sign in (the key is used once and lasts two minutes). Close it and open it again from your dashboard.', true);
  }
  configureConsole(session.token);
  $('console-store').textContent = `Calls · ${session.shop.replace('.myshopify.com', '')}`;
  const saved = (() => { try { return localStorage.getItem('orbi-rep-name') || ''; } catch { return ''; } })();
  $('console-name').value = saved;
  status('Ready. Choose your name and start.');
  icons();
  $('console-go').disabled = false;
  $('console-go').addEventListener('click', async () => {
    const name = $('console-name').value.trim().slice(0, 80);
    if (!name) { $('console-name').focus(); return status('Write the name shoppers should see.', true); }
    try { localStorage.setItem('orbi-rep-name', name); } catch { /* not remembered */ }
    sup.name = name;
    // this click is what lets the ring play later, by itself, from the background
    unlockAudio();
    try { sessionStorage.setItem('orbi-presence', 'online'); } catch { /* not remembered */ }
    $('console-start').hidden = true;
    await initSupport();
    if (!sup.enabled) {
      $('console-start').hidden = false;
      return status('Live help is switched off for this store (Settings, Live help from a person).', true);
    }
    setPresence('online');
    startHome();
    icons();
  });
}
start();
window.addEventListener('beforeunload', (e) => { if (sup.active) { e.preventDefault(); e.returnValue = ''; } });
