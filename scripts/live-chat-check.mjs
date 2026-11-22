// Live check of the agent against REAL Gemini (key from .env) on the recorded TechStore catalog (no Shopify calls).
// Replays the questions that went wrong in live testing, one after another with no pause (so a rate limit is hit and
// waited out), and prints reply, cards, tools used and time per turn. Usage: node scripts/live-chat-check.mjs [count] [startIndex]
// LIVE_VERBOSE=1 also prints the agent's own log lines (provider errors, waits, guards).
import "dotenv/config";
import { installRealStore, freshClientId } from "../test/helpers/agentHarness.js";
import { runAgent, isFallbackAnswer } from "../src/agent/agent.js";

const QUESTIONS = [
  "bag", "something to carry my laptop", "portable charger", "I am thirsty", "baby clothes", "slippers",
  "compare iphone 15 and samsung a55", "dell laptop", "maternity dress", "gift card", "samsung phone",
  "cell phone chahiye", "best mobile dikhao", "boys shirt", "PS5", "fitness band", "wristwatch", "powerbank",
];
const count = Number(process.argv[2]) || QUESTIONS.length;
const start = Number(process.argv[3]) || 0;
const store = installRealStore();
const toolLines = [];
const log = console.log;
if (!process.env.LIVE_VERBOSE) console.log = (...args) => { const line = args.join(" "); if (/^\[tool\]/.test(line)) toolLines.push(line.replace(/^\[tool\] /, "").replace(/ in \d+ ms$/, "")); else if (/^\[(guard|cards)\]/.test(line)) toolLines.push(line); };
if (!process.env.LIVE_VERBOSE) console.warn = (...args) => { const line = args.join(" "); if (/rate limited|guard/.test(line)) toolLines.push(line.slice(0, 120)); };

let degraded = 0;
const times = [];
for (const q of QUESTIONS.slice(start, start + count)) {
  toolLines.length = 0;
  const started = Date.now();
  const r = await runAgent(q, "livecheck.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "INR", items: [] } });
  const ms = Date.now() - started;
  times.push(ms);
  if (isFallbackAnswer(r.answer)) degraded++;
  log(`\n> ${q}   [${(ms / 1000).toFixed(1)} s]${isFallbackAnswer(r.answer) ? "  ** TROUBLE-CONNECTING FALLBACK **" : ""}`);
  log(`  tools: ${toolLines.join(" | ") || "-"}`);
  log(`  cards: ${(r.products || []).map((p) => p.title).join(" | ") || "-"}`);
  log(`  reply: ${r.answer.replace(/\s+/g, " ").slice(0, 330)}`);
}
times.sort((a, b) => a - b);
log(`\n${count} turns; fallback (trouble connecting) replies: ${degraded}; median ${(times[Math.floor(times.length / 2)] / 1000).toFixed(1)} s, slowest ${(times.at(-1) / 1000).toFixed(1)} s`);
store.restore();
process.exit(0);
