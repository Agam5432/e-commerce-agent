// Two things a real shopper hits on a slow model or a long paste (found in the real-shopper run, scripts/e2e-shopper.mjs):
// 1. the opening line never arrives: the chat must show the store's own greeting after a few seconds instead of "..." for ever;
// 2. a paste longer than the server accepts (2000 characters) must be stopped at the box, not answered with "could not connect".
// Run: node slow-greeting-and-long-input.mjs (same prerequisites as e2e.mjs)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setup } from "./harness.mjs";
const { page, browser, errors, chatBodies, check } = await setup();
const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".page.html"), "utf8").replace(/data-greeting="[^"]*"/, 'data-greeting="Welcome to Test Shop! Ask me anything."');
await page.route("https://store.test/", (route) => route.fulfill({ contentType: "text/html", body: html }));
// the model is slow: the AI's greeting would come after 25 s
await page.route("https://store.test/apps/ai-agent/greeting", async (route) => { await new Promise((r) => setTimeout(r, 25000)); await route.fulfill({ contentType: "application/json", body: JSON.stringify({ greeting: "late AI greeting" }) }).catch(() => {}); });
await page.goto("https://store.test/");
await page.waitForTimeout(300);
await page.locator(".ai-commerce-chat-toggle").click();
await page.waitForTimeout(11000);
const first = (await page.locator(".ai-commerce-chat-bot").first().innerText().catch(() => "")).trim();
check("after 11 s of a slow model the store's own greeting is shown, not '...'", /Welcome to Test Shop/.test(first), JSON.stringify(first.slice(0, 50)));

const input = page.locator(".ai-commerce-chat-input");
await input.click();
await page.keyboard.insertText("a".repeat(3000));
const len = await input.evaluate((el) => el.value.length);
check("a 3000-character paste is stopped at 2000 characters (the server limit)", len <= 2000, String(len));
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
const text = await page.locator(".ai-commerce-chat-messages").innerText();
check("the capped message is sent and answered, no 'could not connect'", chatBodies.length === 1 && chatBodies[0].message.length <= 2000 && !/couldn.t connect/i.test(text), `sent ${chatBodies.length}`);
// 3. the AI has no greeting at all and the merchant set none: the chat must still open with a greeting, not empty
const noMerchant = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".page.html"), "utf8").replace(/data-greeting="[^"]*"/, 'data-greeting=""');
await page.route("https://store.test/", (route) => route.fulfill({ contentType: "text/html", body: noMerchant }));
await page.route("https://store.test/apps/ai-agent/greeting", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ greeting: "" }) }));
await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
await page.goto("https://store.test/");
await page.waitForTimeout(400);
if (await page.locator(".ai-commerce-chat-panel").isHidden()) await page.locator(".ai-commerce-chat-toggle").click();
await page.waitForTimeout(2500);
const dflt = (await page.locator(".ai-commerce-chat-bot").first().innerText().catch(() => "")).trim();
check("an empty AI greeting and no merchant greeting still gives a default greeting naming the shop", /Welcome to Test Shop/.test(dflt), JSON.stringify(dflt.slice(0, 60)));
check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
