// A shopper who left a shared computer must not leave their saved details for the next visitor.
// Run: node stale-customer.mjs (same prerequisites as e2e.mjs)
import { setup } from "./harness.mjs";
const { page, browser, errors, chatBodies, check } = await setup();
const KEY = "ai_commerce_customer_";
const seed = JSON.stringify({ loggedIn: true, customer: { id: "1", email: "old@example.com", name: "Old Shopper", phone: null, defaultAddress: null }, updatedAt: Date.now() });

// 1. Logged-out page (no login signal) with details left by someone else: they are removed and never sent.
await page.addInitScript(([k, v]) => { try { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(k, v); sessionStorage.setItem("seeded", "1"); } } catch {} }, [KEY + "test.myshopify.com", seed]);
await page.goto("https://store.test/");
await page.waitForTimeout(500);
const stillThere = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("ai_commerce_customer_")).length);
check("saved details of a previous shopper are forgotten on a logged-out page", stillThere === 0, String(stillThere));

await page.locator(".ai-commerce-chat-fab, .ai-commerce-launcher, .ai-commerce-robot").first().click({ timeout: 3000 }).catch(() => {});
await page.locator(".ai-commerce-chat-input").fill("hello").catch(() => {});
await page.keyboard.press("Enter").catch(() => {});
await page.waitForTimeout(800);
const leaked = chatBodies.some((b) => JSON.stringify(b).includes("old@example.com"));
check("a chat message does not carry the previous shopper's email", !leaked);
check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
