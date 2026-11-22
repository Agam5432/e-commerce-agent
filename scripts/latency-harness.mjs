// Counts the AI calls of a turn and the wall time with a fake model of fixed latency (main call 900 ms, side call 300 ms),
// on the recorded TechStore catalog. Usage: node scripts/latency-harness.mjs
import { installRealStore, scriptedGemini, freshClientId } from "../test/helpers/agentHarness.js";
import { runAgent, __setLLMClientsForTest } from "../src/agent/agent.js";

const MAIN_MS = 900;
const SIDE_MS = 300;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const store = installRealStore();
const search = (searchTerm) => ({ call: [{ name: "search_products", args: { searchTerm } }] });
const sideFor = (types, same = false) => async (req) => {
  await wait(SIDE_MS);
  const prompt = req.contents[0].parts[0].text;
  return /SAME KIND/.test(prompt) ? JSON.stringify(prompt.split("\n").filter((l) => /^\d+\. /.test(l)).map(() => same)) : types;
};
const slow = (fn) => async (...a) => { await wait(MAIN_MS); return fn(...a); };

const CASES = [
  ["direct match (samsung phone)", "samsung phone", [slow(() => search("samsung phone")), slow(() => "The Samsung Galaxy A55 5G is what we have.")], "[]"],
  ["need by meaning (portable charger)", "portable charger", [slow(() => search("portable charger")), slow(() => "Ambrane 10000mAh Power Bank, Anker PowerCore 20000mAh Power Bank and Mi Power Bank 3i 10000mAh.")], '["Power Banks"]', true],
  ["not sold (PS5)", "PS5", [slow(() => search("PS5")), slow(() => "Sorry, PS5 is not available. What else?")], "[]"],
  ["wrong substitute caught (tablet)", "tablet", [slow(() => search("tablet")), slow(() => "No tablets, but the Anker 20W USB-C Fast Charger is good."), slow(() => "We do not have tablets. Anything else?")], "[]"],
  ["false 'no' caught (bag)", "bag", [slow(() => search("bag")), slow(() => "We do not carry any bags."), slow(() => "We have the Dell Essential Briefcase 15 and school bags.")], "[]"],
];
console.log("case".padEnd(40), "main calls  side calls  seconds");
for (const [name, message, steps, types, same] of CASES) {
  const gemini = scriptedGemini(steps, { side: sideFor(types, same) });
  __setLLMClientsForTest({ gemini });
  const started = Date.now();
  await runAgent(message, "latency.myshopify.com", [], "ecommerce", { clientId: freshClientId(), cart: { currency: "INR", items: [] } });
  console.log(name.padEnd(40), String(gemini.main.length).padEnd(12), String(gemini.sideCalls.length).padEnd(11), ((Date.now() - started) / 1000).toFixed(1));
}
store.restore();
process.exit(0);
