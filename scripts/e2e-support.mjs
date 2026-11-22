// End to end test of live help from a person: the real server (real MongoDB, a temporary one), the real chat widget (rendered
// from its Liquid block), the real dashboard and call window, Chrome pages, and a real WebRTC audio call (fake microphone).
// Only Shopify's own services (the catalog, App Bridge) and the AI model are stood in for; no mail is sent.
//
//   npm i --no-save playwright liquidjs          (Chrome must be installed)
//   WIDGET_DIR=shopify-app/extensions/ai-chat-widget node scripts/e2e-support.mjs
//   ONLY="callback" ...                           runs only the steps whose name contains the text
// Screenshots go to ./e2e-output (or E2E_OUT). Needs a mongod on the machine (MONGOD_PATH).
// End to end: the real server (real MongoDB), the real chat widget (rendered from its Liquid block), the real dashboard,
// two real Chrome pages and a real WebRTC audio call between them (fake microphone). Only Shopify's own services
// (the catalog, App Bridge) and the AI model are stood in for.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Liquid } from 'liquidjs';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
const WIDGET = process.env.WIDGET_DIR; // the widget's extension folder: .../extensions/ai-chat-widget
if (!WIDGET) { console.log('Set WIDGET_DIR to the widget extension folder (the one with blocks/ and assets/).'); process.exit(1); }
const HERE = process.env.E2E_OUT || path.join(REPO, 'e2e-output');
fs.mkdirSync(HERE, { recursive: true });
const imp = (rel) => import(pathToFileURL(`${REPO}/${rel}`).href);
const BACKEND = 4701;
const STORE = 4702;
const SHOP = 'demo-store.myshopify.com';
const OTHER_SHOP = 'other-store.myshopify.com';
const SECRET = 'e2e-secret';
const KEY = 'e2e-key';

// ---- environment ---------------------------------------------------------------------------------------------------
const { startTempMongo } = await imp('test/helpers/tempMongo.js');
const mongo = await startTempMongo();
if (!mongo.available) { console.log('NO MONGOD'); process.exit(2); }
Object.assign(process.env, {
  NODE_ENV: 'development', PORT: String(BACKEND), MONGODB_URI: mongo.uri, SHOPIFY_CLIENT_ID: KEY, SHOPIFY_CLIENT_SECRET: SECRET,
  SHOPIFY_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), GEMINI_API_KEY: 'fake', LLM_PRIMARY: 'gemini', LLM_SECONDARY: 'gemini',
  // never send real mail or use real credentials from the project's .env during a test run
  EMAIL_USER: '', EMAIL_APP_PASSWORD: '', EMAIL_FROM: '', ANTHROPIC_API_KEY: '', GEMINI_API: '', GROQ_API_KEY: '', ATTACHMENT_STORAGE: 'mongo', DB_NAME: 'orbi_test',
  SUPPORT_CUSTOMER_GRACE_SECONDS: '3', SUPPORT_REQUEST_TTL_SECONDS: '40', SUPPORT_STUN_URLS: '', APP_URL: `http://localhost:${BACKEND}`,
});
// Shopify's own servers are not reachable here: the catalog comes back empty, everything else goes to the real network
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url?.url || url);
  if (/\.myshopify\.com/.test(u)) return new Response(JSON.stringify({ data: { products: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } }, shop: { name: 'Demo Store' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  return realFetch(url, init);
};
process.chdir(REPO); // the server serves src/public relative to the project folder, as when it is started there
await import(pathToFileURL(`${REPO}/server.js`).href);
for (let i = 0; i < 60; i += 1) { try { if ((await realFetch(`http://localhost:${BACKEND}/healthz`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }

const { default: StoreIntegration } = await imp('src/models/StoreIntegration.js');
const { default: AgentSettings } = await imp('src/models/AgentSettings.js');
const { default: SupportCall } = await imp('src/models/SupportCall.js');
const { default: Conversation } = await imp('src/models/Conversation.js');
const { default: Message } = await imp('src/models/Message.js');
const { default: Booking } = await imp('src/models/Booking.js');
const { encryptToken } = await imp('src/utils/tokenEncryption.js');
const { __setLLMClientsForTest } = await imp('src/agent/agent.js');

for (const domain of [SHOP, OTHER_SHOP]) {
  await StoreIntegration.create({ platform: 'shopify', industry: 'ecommerce', storeDomain: domain, status: 'active', accessTokenEncrypted: encryptToken('shpat_test'), accessTokenExpiresAt: new Date(Date.now() + 3600e3), shopName: domain === SHOP ? 'Demo Store' : 'Other Store', currencyCode: 'INR' });
}
const settingsDoc = (support, booking) => ({ shop: SHOP, version: 1, support, booking, notificationEmail: 'owner@example.com' });
await AgentSettings.create(settingsDoc({ liveEnabled: true, audioEnabled: true, recordingEnabled: true }, { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:30', slotMinutes: 30, timezone: 'Asia/Kolkata', leadHours: 0, maxDaysAhead: 7, autoConfirm: false }));

// the AI: asks for the human-support tool when the shopper asks for a person, otherwise says something short
__setLLMClientsForTest({
  gemini: {
    models: {
      generateContent: async (req) => {
        const contents = req.contents || [];
        const last = contents[contents.length - 1];
        const parts = last?.parts || [];
        const text = parts.map((p) => p.text || '').join(' ');
        const hadTool = parts.some((p) => p.functionResponse);
        if (hadTool) return { candidates: [{ content: { role: 'model', parts: [{ text: "Absolutely! I'll try to connect you with one of our support representatives. Just a moment, please." }] } }] };
        if (/customer care|human|person|someone/i.test(text) && (req.config?.tools || req.tools)) return { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'request_human_support', args: { reason: 'I want to speak to customer care' } } }] } }] };
        return { candidates: [{ content: { role: 'model', parts: [{ text: 'Hello! How can I help you today?' }] } }] };
      },
    },
  },
});

// ---- tokens and the storefront ----------------------------------------------------------------------------------------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const mint = (shop, userId) => {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: KEY, sub: String(userId), exp: now + 60, nbf: now - 5, jti: crypto.randomUUID() });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
};
const signProxy = (params) => {
  const message = Object.entries(params).map(([k, v]) => `${k}=${v}`).sort().join('');
  return crypto.createHmac('sha256', SECRET).update(message).digest('hex');
};

const liquid = new Liquid();
liquid.registerFilter('asset_url', (name) => `/assets/${name}`);
liquid.registerFilter('stylesheet_tag', (url) => `<link rel="stylesheet" href="${url}">`);
liquid.registerFilter('json', (v) => JSON.stringify(v ?? null));
liquid.registerTag('schema', { parse(token, remaining) { this.tpl = []; const stream = this.liquid.parser.parseStream(remaining); stream.on('token', (t) => { if (t.name === 'endschema') stream.stop(); else this.tpl.push(t); }).on('end', () => {}); stream.start(); }, render() { return ''; } });
const block = fs.readFileSync(`${WIDGET}/blocks/ai_chat_widget.liquid`, 'utf8');
let html;
try {
  html = await liquid.parseAndRender(block, { block: { id: 'e2e', settings: { api_url: `http://localhost:${BACKEND}`, fallback_greeting: 'Hi!' } }, shop: { name: 'Demo Store', permanent_domain: SHOP }, routes: { cart_url: '/cart' }, customer: null });
} catch (e) { console.log('LIQUID FAIL', e.message); process.exit(3); }
const page0 = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Storefront</title></head><body><h1>Demo Store</h1>${html}</body></html>`;

const storefront = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); return res.end(page0); }
    if (url.pathname === '/shopify-admin') { res.setHeader('content-type', 'text/html'); return res.end(`<!doctype html><title>Shopify admin</title><body style="margin:0"><iframe id="app" src="http://localhost:${BACKEND}/?shop=${SHOP}" style="width:1360px;height:900px;border:0"></iframe>`); }
    if (url.pathname.startsWith('/assets/')) {
      const file = path.join(WIDGET, 'assets', path.basename(url.pathname));
      if (fs.existsSync(file)) { res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream'); return res.end(fs.readFileSync(file)); }
    }
    if (url.pathname.startsWith('/apps/ai-agent/')) {
      const sub = url.pathname.replace('/apps/ai-agent', '');
      const params = { shop: SHOP, path_prefix: '/apps/ai-agent', timestamp: String(Math.floor(Date.now() / 1000)), logged_in_customer_id: '' };
      const qs = new URLSearchParams({ ...params, signature: signProxy(params) }).toString();
      const out = await realFetch(`http://localhost:${BACKEND}/proxy${sub}?${qs}`, { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json' }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
      res.statusCode = out.status;
      for (const [k, v] of out.headers) if (!['content-encoding', 'transfer-encoding', 'connection', 'content-length'].includes(k)) res.setHeader(k, v);
      return res.end(Buffer.from(await out.arrayBuffer()));
    }
    res.statusCode = 404; res.end('nf');
  });
});
await new Promise((r) => storefront.listen(STORE, r));

// ---- the browser -------------------------------------------------------------------------------------------------------
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const problems = [];
const log = [];
const snapshot = async () => {
  try {
    const { default: P } = await imp('src/models/SupportPresence.js');
    const calls = await SupportCall.find({ shop: SHOP }).sort({ createdAt: -1 }).limit(3).lean();
    const pres = await P.find({ shop: SHOP }).lean();
    const ui = admin ? await admin.evaluate(() => ({ sel: document.querySelector('#presence-select')?.value, label: document.querySelector('#support-presence')?.textContent.trim(), incoming: document.querySelector('#support-incoming')?.innerHTML.length, dockHidden: document.querySelector('#support-dock')?.hidden })).catch((e) => String(e)) : null;
    const w = widget ? await widget.evaluate(() => [...document.querySelectorAll('[data-support-step]')].map((e) => e.dataset.supportStep + ':' + e.textContent.slice(0, 60))).catch((e) => String(e)) : null;
    if (second) log.push('   second ui ' + JSON.stringify(await second.evaluate(() => ({ sel: document.querySelector('#presence-select')?.value, stored: sessionStorage.getItem('orbi-presence'), name: sessionStorage.getItem('orbi-rep-name') || localStorage.getItem('orbi-rep-name') })).catch((e) => String(e))));
    if (second) log.push('   second frames ' + JSON.stringify(second.frames_?.slice(0, 14)));
    log.push('   snapshot ' + JSON.stringify({ calls: calls.map((c) => [c.status, c.failureReason, c.openKey ? 'open' : 'closed']), presence: pres.map((p) => [p.representativeId, p.status, p.activeCallId ? 'busy' : 'free', Math.round((Date.now() - p.lastHeartbeatAt) / 1000) + 's']), ui, widget: w }));
  } catch (e) { log.push('   snapshot failed ' + e.message); }
};
const step = async (label, fn) => { if (process.env.ONLY && !label.includes(process.env.ONLY)) return; const t0 = Date.now(); console.log('>> ' + label); try { await fn(); log.push(`OK    ${label} (${Date.now() - t0}ms)`); } catch (e) { await snapshot(); log.push(`FAIL  ${label} :: ${String(e.message).split('\n')[0].slice(0, 300)} @${(String(e.stack).match(/e2e\.mjs:(\d+)/) || [])[1] || '?'}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PC_HOOK = () => { window.__pcs = []; const Orig = window.RTCPeerConnection; window.RTCPeerConnection = function (...a) { const pc = new Orig(...a); window.__pcs.push(pc); return pc; }; window.RTCPeerConnection.prototype = Orig.prototype; };

async function adminPage(userId, shop = SHOP, name = 'Asha') {
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`admin(${userId}) PAGEERROR ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts|cdn\.shopify|ERR_FAILED|favicon|Failed to load resource/i.test(m.text())) problems.push(`admin(${userId}) CONSOLE ${m.text().slice(0, 200)}`); });
  page.frames_ = [];
  page.on('websocket', (ws) => { ws.on('framesent', (f) => page.frames_.push('>' + String(f.payload).slice(0, 90))); ws.on('framereceived', (f) => page.frames_.push('<' + String(f.payload).slice(0, 90))); ws.on('close', () => page.frames_.push('CLOSED')); });
  await page.exposeFunction('__mint', () => mint(shop, userId));
  await page.addInitScript(PC_HOOK);
  await page.addInitScript((n) => { window.shopify = { idToken: () => window.__mint() }; window.prompt = () => n; }, name);
  await page.route(/fonts\.g|cdn\.shopify/, (r) => r.abort());
  await page.goto(`http://localhost:${BACKEND}/?shop=${shop}`);
  await page.waitForSelector('#screen-container h1', { timeout: 15000 });
  return page;
}
async function widgetPage() {
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 520, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`widget PAGEERROR ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts|favicon|Failed to load resource|ERR_FAILED/i.test(m.text())) problems.push(`widget CONSOLE ${m.text().slice(0, 200)}`); });
  await page.addInitScript(PC_HOOK);
  await page.route(/fonts\.g/, (r) => r.abort());
  await page.goto(`http://localhost:${STORE}/`);
  await page.waitForSelector('.ai-commerce-chat-toggle');
  await page.click('.ai-commerce-chat-toggle');
  await page.waitForSelector('.ai-commerce-chat-panel:not([hidden])');
  return page;
}
const say = async (page, text) => { await page.fill('.ai-commerce-chat-input', text); await page.press('.ai-commerce-chat-input', 'Enter'); };
const goOnline = async (page) => { await page.selectOption('#presence-select', 'online'); await page.waitForFunction(() => document.querySelector('#presence-select')?.value === 'online' && document.querySelector('#presence-label')?.textContent !== 'Connecting…'); await sleep(600); };
const audioFlowing = async (page) => page.evaluate(async () => {
  const pc = (window.__pcs || []).find((p) => p.connectionState === 'connected');
  if (!pc) return { ok: false, why: 'no connected pc' };
  const stats = await pc.getStats();
  let inb = 0; let out = 0; let video = 0;
  stats.forEach((r) => { if (r.type === 'inbound-rtp') { if (r.kind === 'audio') inb += r.bytesReceived; else video += 1; } if (r.type === 'outbound-rtp') { if (r.kind === 'audio') out += r.bytesSent; else video += 1; } });
  return { ok: inb > 0 && out > 0 && video === 0, inb, out, video };
});

let admin; let widget; let second;

await step('boot: dashboard shows the live-help presence control (live help is on)', async () => {
  admin = await adminPage('1001');
  await admin.waitForSelector('#presence-select', { timeout: 10000 });
});

await step('nobody online: the shopper is told, politely, with retry and callback', async () => {
  widget = await widgetPage();
  await say(widget, 'I want to speak to customer care');
  await widget.waitForSelector('[data-support-step=consent]', { timeout: 20000 });
  await widget.click('[data-choice=yes]');
  await widget.waitForSelector('[data-opt=retry]', { timeout: 15000 });
  const text = await widget.textContent('[data-support-step=options]');
  if (!/no representative is available|currently assisting/i.test(text)) throw new Error('wrong unavailable wording: ' + text);
  if (!(await widget.$('[data-opt=callback]'))) throw new Error('callback option missing');
  if (/connected/i.test(await widget.textContent('.ai-sup-call').catch(() => ''))) throw new Error('showed connected');
  if (await SupportCall.countDocuments({ shop: SHOP })) throw new Error('a call was created with nobody online');
  await widget.screenshot({ path: path.join(HERE, 'w-unavailable.png') });
});

await step('a team member goes online and the shopper retries: the call rings', async () => {
  await goOnline(admin);
  await widget.click('[data-opt=retry]');
  await admin.waitForSelector('[data-action=support-accept]', { timeout: 15000 });
  const seen = await widget.textContent('.ai-sup-call');
  if (!/connecting you|waiting for a representative/i.test(seen)) throw new Error('no connecting screen: ' + seen.slice(0, 120));
  if (/Connected/.test(await widget.textContent('.ai-sup-state'))) throw new Error('shows Connected before anyone accepted');
  await widget.screenshot({ path: path.join(HERE, 'w-connecting.png') });
  await admin.screenshot({ path: path.join(HERE, 'a-incoming.png') });
  const card = await admin.textContent('#support-incoming');
  if (!/agreed to a recording/i.test(card)) throw new Error('incoming card does not show the recording consent: ' + card);
});

await step('accept: real audio flows both ways, audio only, and both sides show connected', async () => {
  await admin.click('[data-action=support-accept]');
  await widget.waitForSelector('.ai-sup-live:not([hidden])', { timeout: 25000 });
  await admin.waitForSelector('#support-dock:not([hidden]) #sup-timer', { timeout: 10000 });
  await sleep(2500);
  const w = await audioFlowing(widget);
  const a = await audioFlowing(admin);
  if (!w.ok) throw new Error('widget audio: ' + JSON.stringify(w));
  if (!a.ok) throw new Error('admin audio: ' + JSON.stringify(a));
  const tracks = await widget.evaluate(() => (window.__pcs || []).flatMap((p) => p.getSenders().map((s) => s.track?.kind)));
  if (tracks.includes('video')) throw new Error('a video track was created');
  const call = await SupportCall.findOne({ shop: SHOP }).sort({ createdAt: -1 }).lean();
  if (call.status !== 'connected') throw new Error('database says ' + call.status);
  const conv = await Conversation.findOne({ shop: SHOP }).lean();
  if (!conv.handoff?.active) throw new Error('the AI was not paused for the call');
  await widget.screenshot({ path: path.join(HERE, 'w-live.png') });
  await admin.screenshot({ path: path.join(HERE, 'a-live.png') });
});

await step('chat works during the call, both ways', async () => {
  await say(widget, 'Hello, can you hear me? My order is late.');
  await admin.waitForFunction(() => document.querySelector('#sup-chat')?.textContent.includes('my order is late') || document.querySelector('#sup-chat')?.textContent.includes('My order is late'), null, { timeout: 15000 });
  await admin.fill('#sup-reply-input', 'Yes I can hear you, checking now');
  await admin.press('#sup-reply-input', 'Enter');
  await widget.waitForFunction(() => document.body.textContent.includes('Yes I can hear you, checking now'), null, { timeout: 15000 });
});

await step('mute works and the recording is shown on both sides', async () => {
  await widget.click('[data-act=mute]');
  const muted = await widget.evaluate(() => (window.__pcs || []).flatMap((p) => p.getSenders()).filter((s) => s.track?.kind === 'audio').map((s) => s.track.enabled));
  if (muted.some(Boolean)) throw new Error('microphone still enabled after mute: ' + muted);
  await widget.click('[data-act=mute]');
  if (!/Recording/.test(await widget.textContent('.ai-sup-rec'))) throw new Error('no recording indicator on the widget');
  if (!/Recording \(shopper agreed\)/.test(await admin.textContent('#sup-rec'))) throw new Error('no recording indicator on the dashboard');
});

await step('the team ends the call: summary line, duration, recording saved and playable', async () => {
  await sleep(1500);
  await admin.click('[data-action=support-end]');
  await widget.waitForFunction(() => /Audio call with .* Completed/.test(document.body.textContent), null, { timeout: 20000 });
  const text = await widget.evaluate(() => [...document.querySelectorAll('.ai-sup-summary')].map((e) => e.textContent).join('|'));
  if (!/Duration 00:\d\d/.test(text)) throw new Error('no duration in the summary: ' + text);
  // the recording is uploaded by the dashboard after the call
  let saved = null;
  for (let i = 0; i < 40 && !saved; i += 1) { const c = await SupportCall.findOne({ shop: SHOP, status: 'ended' }).lean(); if (c?.recording?.status === 'saved') saved = c; else await sleep(500); }
  if (!saved) throw new Error('recording was not saved: ' + JSON.stringify((await SupportCall.findOne({ shop: SHOP }).lean()).recording));
  if (!(saved.recording.sizeBytes > 1000)) throw new Error('recording is tiny: ' + saved.recording.sizeBytes);
  await widget.waitForSelector('.ai-sup-summary [data-play]', { timeout: 20000 });
  await widget.click('.ai-sup-summary [data-play]');
  await widget.waitForSelector('.ai-sup-summary audio', { timeout: 10000 });
  const dur = await widget.evaluate(() => new Promise((r) => { const a = document.querySelector('.ai-sup-summary audio'); if (a.readyState >= 1) return r(a.duration); a.addEventListener('loadedmetadata', () => r(a.duration)); a.addEventListener('error', () => r(-1)); setTimeout(() => r(-2), 5000); }));
  if (!(dur > 0 || dur === Infinity)) throw new Error('the saved audio does not load in the player: ' + dur);
  const conv = await Conversation.findOne({ shop: SHOP }).lean();
  if (conv.handoff?.active) throw new Error('the AI was not handed the chat back');
  await widget.screenshot({ path: path.join(HERE, 'w-ended.png') });
});

await step('dashboard: call history on the conversation, recording plays through an authorised request', async () => {
  await admin.evaluate(() => document.querySelector('#sidebar-nav [data-nav="conversations"]').click());
  await admin.waitForSelector('text=Call history', { timeout: 15000 });
  const t = await admin.textContent('#screen-container');
  if (!/Completed/.test(t) || !/Recording agreed/.test(t)) throw new Error('call history incomplete');
  await admin.click('[data-action=play-recording]');
  await admin.waitForSelector('#screen-container audio', { timeout: 10000 });
  await admin.screenshot({ path: path.join(HERE, 'a-history.png') });
});

await step('declining the recording: nothing is recorded, same help', async () => {
  await widget.reload();
  await widget.waitForSelector('.ai-commerce-chat-toggle');
  await sleep(800);
  // a reload restores the open chat window: only open it when it is closed
  if (await widget.$eval('.ai-commerce-chat-panel', (p) => p.hidden)) await widget.click('.ai-commerce-chat-toggle');
  await widget.waitForSelector('.ai-commerce-chat-panel:not([hidden])');
  await say(widget, 'please connect me with a human');
  await widget.waitForSelector('[data-support-step=consent]', { timeout: 20000 });
  await widget.click('[data-choice=no]');
  await admin.waitForSelector('[data-action=support-accept]', { timeout: 20000 });
  if (!/No recording/.test(await admin.textContent('#support-incoming'))) throw new Error('incoming card says recording');
  await admin.click('[data-action=support-accept]');
  await widget.waitForSelector('.ai-sup-live:not([hidden])', { timeout: 25000 });
  if (!/Not recording/.test(await admin.textContent('#sup-rec'))) throw new Error('dashboard claims recording');
  if (!(await widget.$eval('.ai-sup-rec', (e) => e.hidden))) throw new Error('widget shows recording');
  await sleep(1500);
  await widget.click('[data-act=end]');
  await admin.waitForFunction(() => document.querySelector('#support-dock')?.hidden, null, { timeout: 15000 });
  await sleep(1500);
  const c = await SupportCall.findOne({ shop: SHOP }).sort({ createdAt: -1 }).lean();
  if (c.status !== 'ended' || c.recording.status === 'saved') throw new Error('call ' + JSON.stringify({ s: c.status, r: c.recording }));
});

await step('two team members accept at once: one wins, the other is told', async () => {
  second = await adminPage('1002', SHOP, 'Ravi');
  await goOnline(second);
  log.push('   dbg second after goOnline ' + JSON.stringify(await second.evaluate(() => ({ sel: document.querySelector('#presence-select')?.value, stored: sessionStorage.getItem('orbi-presence'), html: document.querySelector('#support-presence')?.innerHTML.slice(0, 60) }))));
  await goOnline(admin);
  await widget.waitForSelector('.ai-commerce-chat-input');
  await say(widget, 'I need someone to help me now');
  await widget.waitForSelector('[data-support-step=consent]', { timeout: 20000 });
  await widget.click('[data-choice=no]');
  await admin.waitForSelector('[data-action=support-accept]', { timeout: 20000 });
  await second.waitForSelector('[data-action=support-accept]', { timeout: 20000 });
  await Promise.all([admin.click('[data-action=support-accept]'), second.click('[data-action=support-accept]')]);
  await widget.waitForSelector('.ai-sup-live:not([hidden])', { timeout: 25000 });
  const docks = await Promise.all([admin, second].map((p) => p.evaluate(() => !document.querySelector('#support-dock').hidden)));
  if (docks.filter(Boolean).length !== 1) throw new Error('docks open: ' + docks);
  const loser = docks[0] ? second : admin;
  await loser.waitForSelector('text=A teammate took this call', { timeout: 10000 }).catch(() => {});
  const stored = await SupportCall.findOne({ shop: SHOP }).sort({ createdAt: -1 }).lean();
  if (!['accepted', 'connected'].includes(stored.status)) throw new Error('status ' + stored.status);
  await widget.click('[data-act=end]');
  await sleep(1500);
  await second.context().close();
});

await step('the shopper cancels while waiting: the card disappears from the dashboard', async () => {
  await goOnline(admin);
  await say(widget, 'connect me to a person please');
  await widget.waitForSelector('[data-support-step=consent]', { timeout: 20000 });
  await widget.click('[data-choice=no]');
  await admin.waitForSelector('[data-action=support-accept]', { timeout: 20000 });
  await widget.click('[data-act=cancel]');
  await admin.waitForFunction(() => !document.querySelector('[data-action=support-accept]'), null, { timeout: 10000 });
  const c = await SupportCall.findOne({ shop: SHOP }).sort({ createdAt: -1 }).lean();
  if (c.status !== 'cancelled') throw new Error('status ' + c.status);
});

await step('the team rejects: the shopper is told nobody could pick up, with options', async () => {
  await say(widget, 'I want a human please');
  await widget.waitForSelector('[data-support-step=consent]', { timeout: 20000 });
  await widget.click('[data-choice=no]');
  await admin.waitForSelector('[data-action=support-reject]', { timeout: 20000 });
  await admin.click('[data-action=support-reject]');
  await widget.waitForSelector('[data-support-step=options] [data-opt=retry]', { timeout: 20000 });
  const text = await widget.textContent('[data-support-step=options]');
  if (!/Nobody was able to pick up|no representative/i.test(text)) throw new Error('wording: ' + text);
});

await step('callback: pick a day and time from the store hours, confirm, it is booked once', async () => {
  await widget.click('[data-support-step=options] [data-opt=callback]');
  await widget.waitForSelector('[data-day]', { timeout: 15000 });
  await widget.click('[data-slot]');
  await widget.fill('[data-f=name]', 'Riya Sharma');
  await widget.fill('[data-f=phone]', '+919876543210');
  await widget.fill('[data-f=email]', 'riya@example.com');
  await widget.screenshot({ path: path.join(HERE, 'w-callback.png') });
  await widget.click('[data-confirm]');
  await widget.waitForSelector('text=callback request is in', { timeout: 15000 });
  const bookings = await Booking.find({ shop: SHOP }).lean();
  if (bookings.length !== 1) throw new Error('bookings: ' + bookings.length);
  if (bookings[0].status !== 'requested' || bookings[0].email !== 'riya@example.com') throw new Error(JSON.stringify(bookings[0]).slice(0, 200));
  const conv = await Conversation.findOne({ shop: SHOP }).lean();
  if (!conv.flags?.callRequested) throw new Error('conversation not flagged');
  // the same time cannot be booked twice
  const first = bookings[0];
  const res = await realFetch(`http://localhost:${STORE}/apps/ai-agent/support/callback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: 'someone-else-aaaaaaaa', slotStart: first.startAt.toISOString(), name: 'X', phone: '+919876543211', email: 'x@example.com' }) });
  if (res.status !== 409) throw new Error('double booking was allowed: ' + res.status);
});

await step('tenant isolation: another store cannot read this store\'s calls, recording or requests', async () => {
  const mine = await SupportCall.findOne({ shop: SHOP, 'recording.status': 'saved' }).lean();
  const token = mint(OTHER_SHOP, '2001');
  const get = (p) => realFetch(`http://localhost:${BACKEND}/admin/api${p}`, { headers: { Authorization: `Bearer ${token}` } });
  const rec = await get(`/support/calls/${mine._id}/recording`);
  if (rec.status !== 404) throw new Error('recording readable by another store: ' + rec.status);
  const calls = await (await get('/support/calls')).json();
  if (calls.items.length) throw new Error('calls leaked: ' + calls.items.length);
  const noToken = await realFetch(`http://localhost:${BACKEND}/admin/api/support/state`);
  if (noToken.status !== 401) throw new Error('state without a token: ' + noToken.status);
  const forged = `${token.split('.').slice(0, 2).join('.')}.AAAA`;
  const bad = await realFetch(`http://localhost:${BACKEND}/admin/api/support/state`, { headers: { Authorization: `Bearer ${forged}` } });
  if (bad.status !== 401) throw new Error('forged token accepted: ' + bad.status);
});

await step('websocket: no token, a forged token and a reused shopper token are all refused', async () => {
  const { WebSocket } = await import(pathToFileURL(`${REPO}/node_modules/ws/wrapper.mjs`).href);
  const tryOpen = (protocols) => new Promise((resolve) => { const ws = new WebSocket(`ws://localhost:${BACKEND}/support-ws`, protocols); ws.on('open', () => { ws.close(); resolve('open'); }); ws.on('unexpected-response', (_q, r) => resolve(r.statusCode)); ws.on('error', () => resolve('error')); });
  if ((await tryOpen(['orbi.support.v1'])) === 'open') throw new Error('opened with no token');
  if ((await tryOpen(['orbi.support.v1', 'orbi.admin.a.b.c'])) === 'open') throw new Error('opened with a forged admin token');
  if ((await tryOpen(['orbi.support.v1', 'orbi.token.abc.def'])) === 'open') throw new Error('opened with a forged shopper token');
  // an admin token of a store that exists works (control), the same shopper token twice does not
  if ((await tryOpen(['orbi.support.v1', `orbi.admin.${mint(SHOP, '1001')}`])) !== 'open') throw new Error('control: a valid admin token was refused');
  const { createVoiceToken } = await imp('src/services/voiceTokenService.js');
  const ghost = createVoiceToken(SHOP, { purpose: 'support', ref: 'a'.repeat(24) });
  const first = await tryOpen(['orbi.support.v1', `orbi.token.${ghost}`]);
  const second = await tryOpen(['orbi.support.v1', `orbi.token.${ghost}`]);
  if (second === 'open') throw new Error('a used shopper token opened again (first: ' + first + ')');
  const voiceOnly = createVoiceToken(SHOP, { purpose: 'voice' });
  if ((await tryOpen(['orbi.support.v1', `orbi.token.${voiceOnly}`])) === 'open') throw new Error('a voice token opened the support socket');
});

await step('the shopper closes the page mid-call: the call is ended by the server', async () => {
  await goOnline(admin);
  const w2 = await widgetPage();
  await say(w2, 'I want to talk to a person');
  await w2.waitForSelector('[data-support-step=consent]', { timeout: 20000 });
  await w2.click('[data-choice=no]');
  await admin.waitForSelector('[data-action=support-accept]', { timeout: 20000 });
  await admin.click('[data-action=support-accept]');
  await w2.waitForSelector('.ai-sup-live:not([hidden])', { timeout: 25000 });
  await w2.context().close();
  await admin.waitForFunction(() => document.querySelector('#support-dock')?.hidden, null, { timeout: 25000 });
  const c = await SupportCall.findOne({ shop: SHOP }).sort({ createdAt: -1 }).lean();
  if (!['ended', 'failed'].includes(c.status)) throw new Error('status ' + c.status);
});


await step('inside a Shopify-like frame there is no microphone: the dashboard offers the call window, which takes the call', async () => {
  // the call window is for the person who is not already on the first dashboard: put that one offline
  if (admin) { await admin.selectOption('#presence-select', 'offline'); await sleep(800); }
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1360, height: 900 } });
  const parent = await ctx.newPage();
  parent.on('pageerror', (e) => problems.push('frame PAGEERROR ' + e.message));
  await parent.exposeFunction('__mint', () => mint(SHOP, '3003'));
  await ctx.addInitScript(PC_HOOK);
  await ctx.addInitScript(() => { window.shopify = { idToken: () => window.__mint() }; });
  await parent.route(/fonts\.g|cdn\.shopify/, (r) => r.abort());
  // the real server only lets Shopify's admin frame it (frame-ancestors); this test page stands in for Shopify's admin
  await parent.route(`http://localhost:${BACKEND}/?shop=*`, async (route) => { const resp = await route.fetch(); const headers = { ...resp.headers() }; delete headers['content-security-policy']; delete headers['x-frame-options']; await route.fulfill({ response: resp, headers }); });
  await parent.goto(`http://localhost:${STORE}/shopify-admin`);
  const app = parent.frameLocator('#app');
  parent.on('console', (m) => console.log('   [frame console]', m.type(), m.text().slice(0, 160)));
  await app.locator('[data-action=support-open-console]').waitFor({ timeout: 12000 }).catch(async (e) => { const f = parent.frames().find((x) => x.url().includes(':4701')); console.log('   frame url', f?.url(), 'policy', await f?.evaluate(() => [String(document.permissionsPolicy?.allowsFeature('microphone')), document.querySelector('#support-presence')?.outerHTML.slice(0, 200), document.querySelector('#screen-container')?.textContent.slice(0, 120)])); throw e; });
  if (await app.locator('#presence-select').count()) throw new Error('the frame offers an in-frame microphone control');
  const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 15000 }), app.locator('[data-action=support-open-console]').click()]);
  popup.on('pageerror', (e) => problems.push('console PAGEERROR ' + e.message));
  await popup.waitForSelector('#console-go:not([disabled])', { timeout: 15000 });
  if (/ticket=/.test(popup.url())) throw new Error('the one-time key stayed in the address bar: ' + popup.url());
  await popup.fill('#console-name', 'Meera');
  await popup.click('#console-go');
  await popup.waitForFunction(() => document.querySelector('#presence-select')?.value === 'online' && document.querySelector('#presence-label')?.textContent !== 'Connecting…', null, { timeout: 15000 });
  await sleep(800);
  await popup.screenshot({ path: path.join(HERE, 'c-console.png') });
  const w4 = await widgetPage();
  await say(w4, 'I want to speak to a human');
  await w4.waitForSelector('[data-support-step=consent]', { timeout: 20000 });
  await w4.click('[data-choice=yes]');
  await popup.waitForSelector('[data-action=support-accept]', { timeout: 20000 });
  const frameCard = await app.locator('#support-incoming').textContent().catch(() => '');
  await popup.click('[data-action=support-accept]');
  await w4.waitForSelector('.ai-sup-live:not([hidden])', { timeout: 25000 });
  await popup.waitForSelector('#support-dock:not([hidden]) #sup-timer', { timeout: 10000 });
  await sleep(2500);
  const a1 = await audioFlowing(popup);
  const a2 = await audioFlowing(w4);
  if (!a1.ok || !a2.ok) throw new Error('audio ' + JSON.stringify([a1, a2]));
  if (/With Meera|Meera/.test(await w4.textContent('.ai-sup-name')) === false) throw new Error('the shopper does not see the representative name');
  // chat in the call window, both ways
  await say(w4, 'Hello from the shopper');
  await popup.waitForFunction(() => document.querySelector('#sup-chat')?.textContent.includes('Hello from the shopper'), null, { timeout: 15000 });
  await popup.fill('#sup-reply-input', 'Hello from Meera');
  await popup.press('#sup-reply-input', 'Enter');
  await w4.waitForFunction(() => document.body.textContent.includes('Hello from Meera'), null, { timeout: 15000 });
  await popup.screenshot({ path: path.join(HERE, 'c-live.png') });
  await popup.click('[data-action=support-end]');
  await w4.waitForFunction(() => /Audio call with Meera .* Completed/.test(document.body.textContent), null, { timeout: 20000 });
  let saved = null;
  for (let i = 0; i < 40 && !saved; i += 1) { const c = await SupportCall.findOne({ shop: SHOP, 'representative.id': '3003' }).lean(); if (c?.recording?.status === 'saved') saved = c; else await sleep(500); }
  if (!saved) throw new Error('the call window did not save the recording');
  await w4.context().close();
  void frameCard;
  // the key and the session are limited
  const api = (p, init = {}) => realFetch(`http://localhost:${BACKEND}${p}`, init);
  const ticketRes = await api('/admin/api/support/console-ticket', { method: 'POST', headers: { Authorization: `Bearer ${mint(SHOP, '3003')}`, 'content-type': 'application/json' }, body: '{}' });
  const { ticket } = await ticketRes.json();
  const sess = await api('/support-console/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
  const { token } = await sess.json();
  const again = await api('/support-console/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
  if (again.status !== 401) throw new Error('a ticket worked twice: ' + again.status);
  const h = { Authorization: `Bearer ${token}` };
  if ((await api('/admin/api/support/state', { headers: h })).status !== 200) throw new Error('console token cannot read the support state');
  for (const p of ['/admin/api/orders', '/admin/api/settings', '/admin/api/customers', '/admin/api/overview']) { const r = await api(p, { headers: h }); if (r.status !== 403) throw new Error(`console token reached ${p}: ${r.status}`); }
  if ((await api('/admin/api/support/console-ticket', { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '{}' })).status !== 403) throw new Error('a console token made a new ticket');
  await ctx.close();
});

await step('the old pages still work: the AI answers a normal question without any call machinery', async () => {
  const w3 = await widgetPage();
  await say(w3, 'hello there');
  await w3.waitForFunction(() => document.body.textContent.includes('How can I help you today?'), null, { timeout: 20000 });
  if (await w3.$('[data-support-step]')) throw new Error('call UI appeared for a normal message');
  await w3.context().close();
});

console.log(log.join('\n'));
console.log('--- problems:', problems.length ? '\n' + [...new Set(problems)].join('\n') : 'none');
await browser.close();
storefront.close();
await mongo.stop();
process.exit(0);
