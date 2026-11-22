// AUTOMATED (real Chromium + the real widget script, scripted backend). Low-severity QA items:
// a lone "." is not sent; the same text sent twice at once is one message; a malformed product list (a null entry) still shows the good cards.
import { setup } from "./harness.mjs";
const { page, browser, check, errors, chatBodies } = await setup();
let calls = 0;
await page.route("**/apps/ai-agent/chat", async (route) => {
  calls += 1;
  const body = { answer: "Here are two phones.", actions: [], products: [null, { title: "Good Phone A", price: "10.00", currency: "USD", variants: [] }, 5, { title: "Good Phone B", price: "12.00", currency: "USD", variants: null }, {}] };
  return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
});
await page.goto("https://store.test/");
await page.click(".ai-commerce-chat-toggle");
await page.waitForTimeout(300);
const send = async (text) => { await page.fill(".ai-commerce-chat-input", text); await page.press(".ai-commerce-chat-input", "Enter"); };

await send(".");
await page.waitForTimeout(400);
check("a lone '.' is not sent to the assistant", calls === 0);
check("the shopper is told to type something", /message with some words/i.test(await page.locator(".ai-commerce-chat-status").innerText().catch(() => "")));
check("the input is empty again and usable", (await page.inputValue(".ai-commerce-chat-input")) === "" && !(await page.isDisabled(".ai-commerce-chat-input")));
await send("?!");
await page.waitForTimeout(300);
check("'?!' is not sent either", calls === 0);

await send("show me phones");
await page.waitForSelector(".ai-commerce-product-grid, .ai-commerce-chat-product, [class*='product-card']", { timeout: 6000 }).catch(() => {});
await page.waitForTimeout(500);
check("the question was sent once", calls === 1, String(calls));
const cardText = await page.locator(".ai-commerce-chat-messages").innerText();
check("the good cards are shown although the list had null, a number and an empty entry", /Good Phone A/.test(cardText) && /Good Phone B/.test(cardText), cardText.slice(-200));
check("no page errors from the malformed list", errors.length === 0, errors.join(" | "));

// the same text again within moments is a duplicate
await send("is it in stock");
await page.waitForTimeout(100);
await page.evaluate(() => { const i = document.querySelector(".ai-commerce-chat-input"); i.value = "is it in stock"; i.closest("form").requestSubmit(); });
await page.waitForTimeout(1500);
check("the same message twice at once ran once", calls === 2, String(calls));
await browser.close();
