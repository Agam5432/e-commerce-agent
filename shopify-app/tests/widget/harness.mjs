// Browser test harness for the storefront widget: renders the real theme block, fakes the backend,
// the voice WebSocket and speech synthesis, and records what the widget sends.
// Needs Playwright (npm i -D playwright) and Python 3 (to render the liquid block).
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = (() => { try { return require("playwright"); } catch { return require(path.join(execFileSync("npm", ["root", "-g"]).toString().trim(), "playwright")); } })();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = path.join(HERE, "..", "..", "extensions", "ai-chat-widget", "assets") + path.sep;
const PAGE = path.join(HERE, ".page.html");
execFileSync(process.env.PYTHON || "python3", [path.join(HERE, "render.py"), path.join(HERE, "..", "..", "extensions", "ai-chat-widget", "blocks", "ai_chat_widget.liquid"), PAGE]);
export async function setup({ audio = path.join(HERE, "silence.wav") } = {}) {
const page_html = fs.readFileSync(PAGE, "utf8");
const browser = await chromium.launch({ ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}), args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${audio}`, "--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ permissions: ["microphone"], ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
const chatBodies = []; const resets = []; const uploads = []; const tokenBodies = [];
await page.addInitScript(() => {
  window.__sent = [];
  window.__spoken = [];
  class FakeWS {
    constructor(url, protocols) { this.url = url; this.protocols = protocols; this.readyState = 0; window.__ws = this; setTimeout(() => { this.readyState = 1; this.onopen && this.onopen({}); }, 20); }
    send(d) { window.__sent.push(d); }
    close() { this.readyState = 3; this.onclose && this.onclose({ code: 1000 }); }
    addEventListener(t, f) { this["on" + t] = f; }
    removeEventListener() {}
  }
  FakeWS.OPEN = 1; FakeWS.CONNECTING = 0; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
  window.WebSocket = FakeWS;
  window.__push = (msg) => window.__ws.onmessage && window.__ws.onmessage({ data: JSON.stringify(msg) });
  const voices = [
    { name: "Google हिन्दी", lang: "hi-IN", localService: false, voiceURI: "g-hi" },
    { name: "Microsoft Kalpana - Hindi (India)", lang: "hi-IN", localService: true, voiceURI: "ms-kalpana" },
    { name: "Microsoft Zira - English (United States)", lang: "en-US", localService: true, voiceURI: "ms-zira" },
  ];
  const synth = { speaking: false, paused: false, getVoices: () => voices, speak(u) { window.__spoken.push({ text: u.text, voice: u.voice && u.voice.name }); setTimeout(() => u.onstart && u.onstart(), 5); setTimeout(() => u.onend && u.onend(), 30); }, cancel() {}, pause() {}, resume() {}, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(window, "speechSynthesis", { value: synth });
  window.SpeechSynthesisUtterance = function (t) { this.text = t; };
  window.Shopify = { currency: { active: "USD" }, country: "US" };
});
await page.route("https://backend.test/**", async (route) => { uploads.push({ url: route.request().url(), auth: route.request().headers()["authorization"] }); return route.fulfill({ contentType: "application/json", headers: {"access-control-allow-origin":"*","access-control-allow-headers":"*"}, body: JSON.stringify({ attachments: [{ id: "a1", name: "x.png", kind: "image" }, { id: "a2", name: "y.png", kind: "image" }] }) }); });
await page.route("https://store.test/**", async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: page_html });
  if (url.pathname.endsWith(".css")) return route.fulfill({ contentType: "text/css", body: fs.readFileSync(A + "ai-chat-widget.css", "utf8") });
  if (url.pathname.endsWith("ai-chat-widget.js")) return route.fulfill({ contentType: "application/javascript", body: fs.readFileSync(A + "ai-chat-widget.js", "utf8") });
  if (url.pathname.endsWith("cart.js")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ item_count: 0, total_price: 0, currency: "USD", items: [] }) });
  if (url.pathname.includes("/apps/ai-agent/voice-token")) tokenBodies.push(JSON.parse(route.request().postData() || "{}"));
  if (url.pathname.includes("/apps/ai-agent/voice-token")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ token: "t" }) });
  if (url.pathname.includes("/apps/ai-agent/greeting")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ greeting: "Hi! What are you looking for?", suggestions: ["Earbuds", "Smart TV"] }) });
  if (url.pathname.includes("/apps/ai-agent/suggestions")) { const b = JSON.parse(route.request().postData() || "{}"); return route.fulfill({ contentType: "application/json", body: JSON.stringify({ suggestions: b.lastUser ? ["Compare these", "Show cheaper ones", "Delivery time?"] : ["Earbuds", "Smart TV"] }) }); }
  if (url.pathname.includes("/apps/ai-agent/chat")) { chatBodies.push(JSON.parse(route.request().postData() || "{}")); return route.fulfill({ contentType: "application/json", body: JSON.stringify({ answer: "Here are TVs.", products: [], actions: [], suggestions: ["Compare these", "Show cheaper ones", "Delivery time?"] }) }); }
  if (url.pathname.includes("/apps/ai-agent/reset-chat")) { resets.push(JSON.parse(route.request().postData() || "{}")); return route.fulfill({ contentType: "application/json", body: "{\"success\":true}" }); }
  if (url.pathname.includes("/apps/ai-agent/")) return route.fulfill({ contentType: "application/json", body: "{}" });
  return route.fulfill({ status: 404, body: "" });
});
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " :: " + extra : ""}`); if (!ok) process.exitCode = 1; };
return { page, browser, errors, chatBodies, resets, uploads, tokenBodies, check };
}
