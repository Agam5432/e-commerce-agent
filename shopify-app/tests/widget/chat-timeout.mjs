// AUTOMATED (real Chromium + the real widget script, scripted backend). M1: a chat request that never answers must not freeze the widget.
// After the timeout the input works again, a Retry button re-sends the same message, and a reply that arrives after "Clear chat"
// never appears in the new conversation.
import { setup } from "./harness.mjs";
const { page, browser, check, errors } = await setup();
await page.addInitScript(() => { window.__orbiChatTimeoutMs = 1200; });
let calls = 0;
let release = null;
await page.route("**/apps/ai-agent/chat", async (route) => {
  calls += 1;
  if (calls === 1) return new Promise(() => {}); // never answers (the page aborts it)
  if (calls === 3) { await new Promise((r) => { release = r; }); return route.fulfill({ contentType: "application/json", body: JSON.stringify({ answer: "LATE ANSWER from the old chat", products: [], actions: [] }) }).catch(() => {}); }
  return route.fulfill({ contentType: "application/json", body: JSON.stringify({ answer: "Here you go: reply " + calls, products: [], actions: [] }) });
});
await page.goto("https://store.test/");
await page.click(".ai-commerce-chat-toggle");
await page.waitForTimeout(300);

await page.fill(".ai-commerce-chat-input", "show me phones");
await page.press(".ai-commerce-chat-input", "Enter");
await page.waitForTimeout(400);
check("while waiting, the input is locked", await page.isDisabled(".ai-commerce-chat-input"));
await page.waitForSelector(".ai-commerce-chat-retry", { timeout: 4000 });
check("after the timeout the input is usable again", !(await page.isDisabled(".ai-commerce-chat-input")));
check("the shopper is told it took too long", /taking longer than expected/i.test(await page.locator(".ai-commerce-chat-messages").innerText()));
await page.click(".ai-commerce-chat-retry");
await page.waitForFunction(() => /reply 2/.test(document.body.innerText), null, { timeout: 4000 });
const text = await page.locator(".ai-commerce-chat-messages").innerText();
check("Retry sent the same message again and got the answer", /reply 2/.test(text));
check("the failed attempt is gone (the message is not shown twice)", (text.match(/show me phones/g) || []).length === 1, text);

// a reply that arrives after Clear chat belongs to the old conversation
await page.fill(".ai-commerce-chat-input", "second question");
await page.press(".ai-commerce-chat-input", "Enter");
await page.waitForTimeout(300);
await page.evaluate(() => { document.querySelector(".ai-commerce-chat-menu-clear")?.click(); });
await page.waitForTimeout(200);
await page.evaluate(() => { document.querySelector(".ai-commerce-confirm-yes")?.click(); });
await page.waitForTimeout(900);
release && release();
await page.waitForTimeout(700);
check("the late answer of the cleared chat is not shown", !/LATE ANSWER/.test(await page.locator(".ai-commerce-chat-messages").innerText()));
check("input is usable after the cleared chat", !(await page.isDisabled(".ai-commerce-chat-input")));
check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
