// Does the REAL AI model (the keys in .env) ask for a person when, and only when, the shopper clearly wants one, and never
// claim that someone has joined? Uses a temporary database; the store's catalog is empty; no mail is sent.
//   node scripts/live-llm-support.mjs
// The real AI model (your Gemini key from .env), a temporary database and no mail: does the agent ask for a person when,
// and only when, the shopper clearly wants one?
import { pathToFileURL, fileURLToPath } from 'node:url';
const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
const imp = (rel) => import(pathToFileURL(`${REPO}/${rel}`).href);
const { startTempMongo } = await imp('test/helpers/tempMongo.js');
const mongo = await startTempMongo();
if (!mongo.available) { console.log('NO MONGOD'); process.exit(2); }
process.chdir(REPO);
// load the project's own .env for the model keys, then make sure nothing outside the test is reachable
await import(pathToFileURL(`${REPO}/node_modules/dotenv/config.js`).href);
Object.assign(process.env, { NODE_ENV: 'development', MONGODB_URI: mongo.uri, DB_NAME: 'orbi_test', EMAIL_USER: '', EMAIL_APP_PASSWORD: '', EMAIL_FROM: '', ATTACHMENT_STORAGE: 'mongo' });
const keyNames = ['GEMINI_API_KEY', 'GEMINI_API', 'ANTHROPIC_API_KEY'].filter((k) => process.env[k]);
console.log('model keys present:', keyNames.join(',') || 'none');
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url?.url || url);
  if (/\.myshopify\.com/.test(u)) return new Response(JSON.stringify({ data: { products: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } }, shop: { name: 'Demo Store' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  return realFetch(url, init);
};
const { default: StoreIntegration } = await imp('src/models/StoreIntegration.js');
const { default: AgentSettings } = await imp('src/models/AgentSettings.js');
const { default: SupportPresence } = await imp('src/models/SupportPresence.js');
const { encryptToken } = await imp('src/utils/tokenEncryption.js');
const { runAgent } = await imp('src/agent/agent.js');
const SHOP = 'live-llm.myshopify.com';
await StoreIntegration.create({ platform: 'shopify', industry: 'ecommerce', storeDomain: SHOP, status: 'active', accessTokenEncrypted: encryptToken('shpat_test'), accessTokenExpiresAt: new Date(Date.now() + 3600e3), shopName: 'Demo Store', currencyCode: 'INR' });
const { invalidateSettings } = await imp('src/admin/settings.js');

async function ask(label, message, { live = true, online = true, history = [] } = {}) {
  await AgentSettings.deleteMany({ shop: SHOP });
  await AgentSettings.create({ shop: SHOP, version: 1, ...(live ? { support: { liveEnabled: true, audioEnabled: true, recordingEnabled: true } } : {}), booking: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], from: '10:00', to: '18:00', slotMinutes: 30, timezone: 'Asia/Kolkata', leadHours: 1, maxDaysAhead: 7 } });
  invalidateSettings(SHOP);
  await SupportPresence.deleteMany({ shop: SHOP });
  if (online) await SupportPresence.create({ shop: SHOP, representativeId: 'rep1', name: 'Asha', status: 'online', lastHeartbeatAt: new Date() });
  const t0 = Date.now();
  const out = await runAgent(message, SHOP, history, 'ecommerce', { clientId: `live${Math.random().toString(16).slice(2, 10)}`, cart: { currency: 'INR', items: [] } });
  const human = (out.actions || []).find((a) => a.type === 'human_support');
  console.log(`\n[${label}] ${Date.now() - t0}ms  human_support=${human ? `YES available=${human.available} allBusy=${human.allBusy}` : 'no'}\n   AI says: ${String(out.answer).replace(/\s+/g, ' ').slice(0, 260)}`);
  return { human, answer: String(out.answer) };
}

const results = {};
results.en = await ask('explicit request (English)', 'I want to speak to customer care.');
results.hi = await ask('explicit request (Hinglish)', 'mujhe kisi insaan se baat karni hai, kisi ko connect karo');
results.now = await ask('call me right now', 'Can someone call me right now?');
results.busy = await ask('nobody online', 'Connect me with a human.', { online: false });
results.off = await ask('live help switched off', 'I want to speak to customer care.', { live: false });
results.policy = await ask('a normal question', 'What is your return policy?');
results.chat = await ask('only a problem (no ask for a person)', 'My order is late, can you check what is going on?');

const claims = (t) => /(has joined|is now connected|you are connected|connected with (a|our) (representative|agent)|will join in \d)/i.test(t);
const verdict = [
  ['asks for a person (English) -> tool', Boolean(results.en.human)],
  ['asks for a person (Hinglish) -> tool', Boolean(results.hi.human)],
  ['"call me right now" -> tool', Boolean(results.now.human)],
  ['tool even when nobody is online (the backend, not the AI, decides)', Boolean(results.busy.human) && results.busy.human.available === false],
  ['live help off -> no tool, no call card', !results.off.human],
  ['return policy question -> no tool', !results.policy.human],
  ['a problem alone -> no tool', !results.chat.human],
  ['AI never claims a person joined / connected', ![results.en, results.hi, results.now, results.busy].some((r) => claims(r.answer))],
];
console.log('\n' + verdict.map(([l, ok]) => `${ok ? 'PASS' : 'FAIL'}  ${l}`).join('\n'));
await mongo.stop();
process.exit(0);
