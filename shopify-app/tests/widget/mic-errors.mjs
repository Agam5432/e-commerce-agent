// AUTOMATED (real Chromium + the real widget script; getUserMedia is STUBBED to fail the way browsers do, so this is not a real-microphone test).
// M2: each way the microphone can be refused gets its own message and recovery instruction; nothing is shown as "Connected", no greeting is
// spoken, no voice token is fetched and no socket is opened; the mic button works again; and a second attempt that succeeds works.
import { setup } from "./harness.mjs";
const { page, browser, check, errors, tokenBodies } = await setup();
await page.addInitScript(() => {
  window.__gum = "NotAllowedError";
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (c) => (window.__gum ? Promise.reject(new DOMException("x", window.__gum)) : real(c));
});
await page.goto("https://store.test/");
await page.click(".ai-commerce-chat-toggle");
await page.waitForTimeout(300);
const statusText = () => page.locator(".ai-commerce-chat-status").innerText().catch(() => "");
const cases = [
  ["NotAllowedError", /blocked.*allow the microphone/i],
  ["NotFoundError", /No microphone was found/i],
  ["NotReadableError", /another app or tab/i],
];
for (const [name, re] of cases) {
  await page.evaluate((n) => { window.__gum = n; }, name);
  await page.click(".ai-commerce-chat-mic");
  await page.waitForTimeout(500);
  const body = await page.evaluate(() => document.body.innerText);
  check(`${name}: a specific message with what to do`, re.test(body), (await statusText()));
  check(`${name}: never shown as connected`, !/connected|listening/i.test(await statusText()) || re.test(await statusText()));
  check(`${name}: mic button is idle and clickable again`, !(await page.isDisabled(".ai-commerce-chat-mic")) && !(await page.evaluate(() => document.querySelector(".ai-commerce-chat-mic").classList.contains("is-listening"))));
  check(`${name}: no socket opened, no token fetched, no greeting spoken`, (await page.evaluate(() => !window.__ws && window.__spoken.length === 0)) && tokenBodies.length === 0);
}
// the shopper fixes the problem and tries again: voice now starts (the harness' fake microphone)
await page.evaluate(() => { window.__gum = null; });
await page.click(".ai-commerce-chat-mic");
await page.waitForTimeout(900);
check("after the fix, voice connects", await page.evaluate(() => !!window.__ws && document.querySelector(".ai-commerce-chat-mic").classList.contains("is-listening")));
check("no page errors", errors.every((e) => /Microphone request failed/.test(e)), errors.join(" | "));
await browser.close();
