// Text chat goes through the app proxy (/apps/ai-agent/chat); it must not need the backend address that only voice and
// uploads use. With no "Chat backend URL" in the theme block and a proxy that cannot report one, a message must still be sent.
// Run: node chat-without-backend-url.mjs (same prerequisites as e2e.mjs)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setup } from "./harness.mjs";
const { page, browser, errors, chatBodies, check } = await setup();
const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".page.html"), "utf8").replace('data-api-url="https://backend.test"', 'data-api-url=""');
await page.route("https://store.test/", (route) => route.fulfill({ contentType: "text/html", body: html }));
await page.goto("https://store.test/");
await page.waitForTimeout(400);
await page.locator(".ai-commerce-chat-toggle").click();
await page.locator(".ai-commerce-chat-input").fill("show me shirts");
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
const text = await page.locator(".ai-commerce-chat-messages").innerText();
check("the message reaches the chat endpoint without a backend URL", chatBodies.length === 1 && chatBodies[0].message === "show me shirts", String(chatBodies.length));
check("no 'still being set up' message for text chat", !/still being set up/i.test(text));
check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
