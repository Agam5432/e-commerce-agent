// The assistant must not stop talking because the microphone heard its OWN voice, and a real interruption must still stop it.
// Words heard while it speaks arrive as "partial" messages from the voice server: its own sentence is ignored, other words interrupt.
import { setup } from "./harness.mjs";
const { page, browser, errors, check } = await setup();
await page.goto("https://store.test/");
await page.click(".ai-commerce-chat-toggle");
await page.waitForTimeout(400);
await page.click(".ai-commerce-chat-mic");
await page.waitForTimeout(800);
check("voice socket opened", await page.evaluate(() => Boolean(window.__ws)));

// the browser's voice speaks and does not finish by itself: the assistant is "in the middle of a sentence"
await page.evaluate(() => {
  window.__cancels = 0;
  const synth = window.speechSynthesis;
  synth.speak = (u) => { window.__utter = u; window.__spoken.push({ text: u.text }); setTimeout(() => u.onstart && u.onstart(), 5); };
  synth.cancel = () => { window.__cancels++; };
});
const ANSWER = "Of course, I'll help you with your complaint. Could you tell me which product arrived damaged and when you received it?";
await page.evaluate((text) => window.__push({ type: "answer", text, runId: 1, products: [], actions: [] }), ANSWER);
await page.waitForTimeout(400);
const label = async () => (await page.locator(".ai-commerce-chat-voice-label").textContent()).trim();
check("the assistant is speaking", /speaking/i.test(await label()) || (await page.evaluate(() => window.__spoken.length)) > 0, await label());
const interrupts = () => page.evaluate(() => window.__sent.map((d) => { try { return JSON.parse(d); } catch { return {}; } }).filter((m) => m.type === "interrupt").length);
await page.evaluate(() => { window.__cancels = 0; window.__sent.length = 0; });

// 1. the microphone hears the assistant itself (the voice server writes it down as the shopper's words)
for (const heard of [
  "of course i'll help you with your complaint",
  "help you with your complaint could you tell me which product arrived damaged",
  "could you tell me which product arrived damaged and when you received it",
]) {
  await page.evaluate((text) => window.__push({ type: "partial", text }), heard);
  await page.waitForTimeout(80);
}
check("its own words heard back do not stop it", (await page.evaluate(() => window.__cancels)) === 0, "cancels=" + (await page.evaluate(() => window.__cancels)));
check("its own words heard back are not sent as an interruption", (await interrupts()) === 0);
check("it is still speaking after hearing itself", /speaking/i.test(await label()), await label());
check("its own words never appear as something the shopper said", !(await page.locator(".ai-commerce-chat-user").allTextContents()).some((t) => /complaint/i.test(t)));

// 2. the shopper really interrupts: other words
await page.evaluate(() => window.__push({ type: "partial", text: "wait stop I already told you that twice" }));
await page.waitForTimeout(150);
check("a real interruption still stops it", (await page.evaluate(() => window.__cancels)) >= 1, "cancels=" + (await page.evaluate(() => window.__cancels)));
check("the server is told about the interruption", (await interrupts()) >= 1);

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
