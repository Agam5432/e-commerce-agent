import { setup } from "./harness.mjs";
const { page, browser, errors, chatBodies, resets, uploads, tokenBodies, check } = await setup();
const $ = (s) => page.locator(s);
const spokenCount = () => page.evaluate(() => window.__spoken.length);
await page.goto("https://store.test/");
await page.waitForTimeout(300);

// ---- launcher: teaser rotates while closed ----
await page.waitForTimeout(3800);
check("teaser shows on the robot", await $(".ai-commerce-teaser").isVisible());
const t1 = await $(".ai-commerce-teaser-text").textContent();
await page.waitForTimeout(4600);
const t2 = await $(".ai-commerce-teaser-text").textContent();
check("teaser rotates messages", t1 !== t2, `${t1} -> ${t2}`);

// ---- open, English UI, greeting + chips ----
await page.click(".ai-commerce-chat-toggle");
await page.waitForTimeout(900);
check("teaser hides when chat opens", !(await $(".ai-commerce-teaser").isVisible()));
check("UI is English by default", /Today/.test(await $(".ai-commerce-welcome-banner").textContent()));
check("greeting chips from the AI", (await $(".ai-commerce-chat-chip").count()) === 2, String(await $(".ai-commerce-chat-chip").count()));
check("header has minimize and close", (await $(".ai-commerce-chat-minimize").isVisible()) && (await $(".ai-commerce-chat-close").isVisible()));

// ---- text chat never speaks ----
await page.fill(".ai-commerce-chat-input", "show tvs");
await page.press(".ai-commerce-chat-input", "Enter");
await page.waitForTimeout(700);
check("text reply is NOT spoken", (await spokenCount()) === 0, String(await spokenCount()));
const chips = await $(".ai-commerce-chat-chip").allTextContents();
check("new chips after the reply", chips.join("|") === "Compare these|Show cheaper ones|Delivery time?", chips.join("|"));
await $(".ai-commerce-chat-chip").first().click();
await page.waitForTimeout(700);
check("chip click sends that text", chatBodies.at(-1)?.message === "Compare these", chatBodies.at(-1)?.message);

// ---- language: real Hindi UI ----
await page.selectOption(".ai-commerce-chat-lang-select", "hi");
await page.waitForTimeout(100);
check("UI switches to Hindi", /[\u0900-\u097F]/.test(await $(".ai-commerce-welcome-banner").textContent() || "") || /[\u0900-\u097F]/.test(await $(".ai-commerce-chat-menu-clear span").textContent()));
check("placeholder in Hindi", /[\u0900-\u097F]/.test(await $(".ai-commerce-chat-input").getAttribute("placeholder")));
await page.selectOption(".ai-commerce-chat-lang-select", "en");

// ---- approved layout: medium panel, no expand button, compact product cards ----
await page.route("https://store.test/apps/ai-agent/chat**", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ answer: "These fit your budget:", actions: [], products: [1, 2, 3].map((i) => ({ id: "gid://shopify/Product/" + i, title: "Earbuds " + i, handle: "e" + i, price: 1799, compareAtPrice: i === 1 ? 2499 : null, currency: "INR", inventoryQuantity: 20, image: null, variants: [{ id: "gid://shopify/ProductVariant/" + i, title: "Default Title", price: 1799, available: true, quantity: 20 }] })) }) }));
const panelWidth = await page.evaluate(() => document.querySelector(".ai-commerce-chat-panel").getBoundingClientRect().width);
check("panel is the medium size (520-580px)", panelWidth >= 519 && panelWidth <= 581, String(panelWidth));
check("no expand button", (await $(".ai-commerce-chat-expand").count()) === 0);
await page.fill(".ai-commerce-chat-input", "earbuds");
await page.press(".ai-commerce-chat-input", "Enter");
await page.waitForTimeout(1200);
check("three compact product cards, no header or arrows", (await $(".ai-commerce-product-card").count()) === 3 && (await $(".ai-commerce-carousel-header, .ai-commerce-carousel-arrow").count()) === 0);
check("card width is 178px", Math.round(await page.evaluate(() => document.querySelector(".ai-commerce-product-card").getBoundingClientRect().width)) === 178);
check("whole prices have no .00", /^₹1,799\s*$/.test(await $(".ai-commerce-product-price").first().textContent()));
check("single-option product has no variant dropdown", (await $(".ai-commerce-product-variant").count()) === 0);
// ---- bullets, links and variant chips ----
await page.route("https://store.test/apps/ai-agent/chat**", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ answer: "Here you go:\n- **Earbuds** (₹1,799): best battery\n- **Neckband** (₹1,899): lightest\n[Pay ₹49,781.25](https://store.test/pay/abc?token=averyveryverylongtokenvalue1234567890) or [bad](javascript:alert(1))", actions: [], products: [{ id: "gid://shopify/Product/9", title: "Earbuds 9", handle: "e9", price: 1799, currency: "INR", inventoryQuantity: 20, image: null, variants: [{ id: "v1", title: "Navy", price: 1799, available: true, quantity: 20 }, { id: "v2", title: "Rose", price: 1899, available: true, quantity: 2 }] }] }) }));
await page.fill(".ai-commerce-chat-input", "bullets");
await page.press(".ai-commerce-chat-input", "Enter");
await page.waitForTimeout(1500);
check("bot reply renders bullets", (await $(".ai-commerce-bot-bubble li, .ai-commerce-message-bot li").count()) >= 2 || (await page.locator("li:has-text('best battery')").count()) >= 1);
const link = page.locator("a.ai-commerce-inline-link");
check("markdown link renders as one anchor", (await link.count()) === 1 && (await link.first().textContent()) === "Pay ₹49,781.25" && (await link.first().getAttribute("target")) === "_blank");
check("raw markdown link syntax is not shown", !(await page.locator(".ai-commerce-chat-messages").textContent()).includes("](https://"));
check("non-http link stays text", (await page.locator("a[href^='javascript']").count()) === 0);
check("variants render as chips", (await $(".ai-commerce-variant-chip").count()) === 2 && (await $(".ai-commerce-product-variant select").count()) === 0);
await page.locator(".ai-commerce-variant-chip", { hasText: "Rose" }).click();
check("choosing a chip updates price and stock pill", /1,899/.test(await $(".ai-commerce-product-price").last().textContent()) && /Only 2 left/.test(await $(".ai-commerce-product-stock").last().textContent()));
await page.unroute("https://store.test/apps/ai-agent/chat**");

// ---- attachments ----
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
await page.setInputFiles(".ai-commerce-chat-file", [1, 2].map((i) => ({ name: `p${i}.png`, mimeType: "image/png", buffer: png })));
check("tray shows 2 thumbnails", (await $(".ai-commerce-tray .ai-commerce-file").count()) === 2);
await $(".ai-commerce-tray .ai-commerce-file-rm").first().click();
check("per-file remove works", (await $(".ai-commerce-tray .ai-commerce-file").count()) === 1);
await page.setInputFiles(".ai-commerce-chat-file", [{ name: "p3.png", mimeType: "image/png", buffer: png }]);
await page.setInputFiles(".ai-commerce-chat-file", [{ name: "bad.exe", mimeType: "application/x-msdownload", buffer: Buffer.from("x") }]);
check("unsupported type rejected", (await $(".ai-commerce-tray .ai-commerce-file").count()) === 2 && /not supported/.test(await $(".ai-commerce-tray-note").textContent()));
check("Find similar chip for photos", (await $(".ai-commerce-chat-chip").allTextContents()).includes("Find similar"));
await page.press(".ai-commerce-chat-input", "Enter"); // attachments only
await page.waitForTimeout(800);
check("attachments-only send works", chatBodies.at(-1)?.attachments?.join() === "a1,a2", JSON.stringify(chatBodies.at(-1)?.attachments));
check("upload goes to backend with token", uploads.at(-1)?.url.endsWith("/api/uploads") && uploads.at(-1)?.auth === "Bearer t", JSON.stringify(uploads.at(-1)));
check("each upload asks for its own upload token", tokenBodies.some((b) => b.purpose === "upload"), JSON.stringify(tokenBodies));
check("sent bubble shows a grid", (await $(".ai-commerce-chat-user .ai-commerce-attach-grid .ai-commerce-file").count()) === 2);
check("tray empties after send", await $(".ai-commerce-tray").isHidden());
await page.setInputFiles(".ai-commerce-chat-file", [{ name: "p4.png", mimeType: "image/png", buffer: png }]);
await $(".ai-commerce-tray-clear").click();
check("clear-all empties the tray", await $(".ai-commerce-tray").isHidden());

// ---- voice call ----
await page.click(".ai-commerce-chat-mic");
await page.waitForTimeout(900);
check("call strip visible with Connected + timer", (await $(".ai-commerce-chat-voice").isVisible()) && /Connected/.test(await $(".ai-commerce-voice-call").textContent()));
check("form hidden during the call", await $(".ai-commerce-chat-form").isHidden());
check("mic pill says on", (await $(".ai-commerce-voice-micpill").getAttribute("data-s")) === "on");
await $(".ai-commerce-voice-center-mic").click();
check("mute works", (await $(".ai-commerce-voice-micpill").getAttribute("data-s")) === "muted" && /muted/i.test(await $(".ai-commerce-chat-voice-label").textContent()));
await $(".ai-commerce-voice-center-mic").click();
await page.evaluate(() => window.__push({ type: "transcript", text: "show tv", runId: 5 }));
await page.waitForTimeout(60);
check("thinking pauses the mic", (await $(".ai-commerce-voice-micpill").getAttribute("data-s")) === "paused");
await page.evaluate(() => window.__push({ type: "answer", text: "Here are two TVs.", runId: 5, products: [], actions: [], suggestions: ["Compare them"] }));
await page.waitForTimeout(300);
check("voice reply IS spoken", (await spokenCount()) >= 1);
// minimize during a call → robot shows live state
await $(".ai-commerce-chat-minimize").click();
await page.waitForTimeout(500);
const live = await $(".ai-commerce-chat-toggle").getAttribute("data-live");
check("robot shows live call state when minimized", ["listening", "thinking", "speaking"].includes(live), String(live));
check("teaser shows call status", /\d\d:\d\d/.test(await $(".ai-commerce-teaser-text").textContent()));
await $(".ai-commerce-chat-toggle").click();
await page.waitForTimeout(400);
await $(".ai-commerce-voice-end").click();
await page.waitForTimeout(300);
check("end call restores the text chat", await $(".ai-commerce-chat-form").isVisible() && await $(".ai-commerce-chat-voice").isHidden());
check("robot live state cleared", (await $(".ai-commerce-chat-toggle").getAttribute("data-live")) === null);
const afterVoice = await spokenCount();
await page.fill(".ai-commerce-chat-input", "thanks");
await page.press(".ai-commerce-chat-input", "Enter");
await page.waitForTimeout(700);
check("text after call is silent again", (await spokenCount()) === afterVoice);

// ---- clear chat ----
await $(".ai-commerce-chat-menu-btn").click();
await $(".ai-commerce-chat-menu-clear").click();
check("confirm dialog opens", await $(".ai-commerce-confirm").isVisible());
await $(".ai-commerce-confirm-no").click();
check("cancel keeps the chat", (await $(".ai-commerce-chat-user").count()) > 0 && await $(".ai-commerce-confirm").isHidden());

// ---- a reload keeps the sent files as labelled tiles ----
await page.reload();
await page.waitForTimeout(600);
if (!(await $(".ai-commerce-chat-user").first().isVisible().catch(() => false))) { await page.click(".ai-commerce-chat-toggle"); await page.waitForTimeout(400); }
const restored = $(".ai-commerce-chat-user .ai-commerce-attach-grid .ai-commerce-file");
check("sent files survive a reload as tiles", (await restored.count()) === 2, String(await restored.count()));
check("restored tile is labelled with the file type", /IMG/.test(await restored.first().textContent()) && (await restored.first().getAttribute("title")) === "p2.png");
await $(".ai-commerce-chat-menu-btn").click();
await $(".ai-commerce-chat-menu-clear").click();
await $(".ai-commerce-confirm-yes").click();
await page.waitForTimeout(1200);
check("chat cleared", (await $(".ai-commerce-chat-user").count()) === 0);
check("server told it was the shopper", resets.at(-1)?.byShopper === true, JSON.stringify(resets.at(-1)));
check("fresh greeting after clear", (await $(".ai-commerce-chat-bot").count()) >= 1);

check("no page errors", errors.length === 0, errors.join(" | "));
// ---- checkout card follows the chosen language ----
await page.route("https://store.test/apps/ai-agent/chat**", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ answer: "Order ready.", actions: [{ type: "checkout_ready", currency: "INR", cart: { currency: "INR", total_price: 3598000, items: [{ title: "Earbuds", quantity: 2, line_price: 3598000 }] }, shipping: { name: "A", address1: "1 Road", city: "Pune", country: "IN" }, originalTotal: 35980, shippingCost: 0, tax: 6476.4, total: 42456.4 }], products: [] }) }));
await page.selectOption(".ai-commerce-chat-lang-select", "hi");
await page.fill(".ai-commerce-chat-input", "checkout");
await page.press(".ai-commerce-chat-input", "Enter");
await page.waitForTimeout(1500);
const hiCard = await $(".ai-commerce-checkout-panel").last().innerText();
check("Hindi checkout card: labels are Hindi", /ऑर्डर की समीक्षा/.test(hiCard) && /डिलीवरी का पता/.test(hiCard) && /कुल/.test(hiCard) && /कैश ऑन डिलीवरी/.test(hiCard));
check("Hindi checkout card: no leftover English labels", !/Order Review|Delivery Address|Subtotal|Cash on Delivery|FREE|Shipping method/.test(hiCard), hiCard.slice(0, 80));
await page.selectOption(".ai-commerce-chat-lang-select", "en");
await page.unroute("https://store.test/apps/ai-agent/chat**");

// ---- order cards: "Order Placed" only for an order Shopify confirmed; a payment link is not an order ----
await page.route("https://store.test/apps/ai-agent/chat**", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ answer: "Complete payment through Shopify: [Pay $7.99](https://store.test/invoice/abc). Your order will appear in Shopify and your account after payment.", actions: [{ type: "checkout_redirect", url: "https://store.test/invoice/abc", checkoutUrl: "https://store.test/invoice/abc", paymentRequired: true }], products: [] }) }));
await page.fill(".ai-commerce-chat-input", "pay online");
await page.press(".ai-commerce-chat-input", "Enter");
await page.waitForTimeout(1200);
const panelsAfterLink = await $(".ai-commerce-checkout-panel").allInnerTexts();
check("a payment link alone shows no 'Order Placed' card", !panelsAfterLink.some((t) => /Order Placed|Order ID/.test(t)), panelsAfterLink.join("|").slice(0, 80));
await page.unroute("https://store.test/apps/ai-agent/chat**");
await page.route("https://store.test/apps/ai-agent/chat**", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ answer: "Your order is placed.", actions: [{ type: "order_placed", orderId: "#1042", paymentMethod: "cod", currency: "USD", subtotal: 7.99, shippingCost: 0, tax: 0, total: 7.99, cart: { currency: "USD", total_price: 799, items: [{ title: "Tee", quantity: 1, line_price: 799 }] }, shipping: { name: "A", address1: "1 Road", city: "Pune", country: "IN" } }], products: [] }) }));
await page.fill(".ai-commerce-chat-input", "yes place it");
await page.press(".ai-commerce-chat-input", "Enter");
await page.waitForTimeout(1200);
const placedCard = (await $(".ai-commerce-checkout-panel").allInnerTexts()).join(" ");
check("a confirmed order shows the Shopify order number and total", /#1042/.test(placedCard) && /7\.99/.test(placedCard), placedCard.slice(0, 120));
await page.unroute("https://store.test/apps/ai-agent/chat**");

// ---- the store or shopper is rate limited: a short, translated "please wait", not "couldn't connect" ----
await page.route("https://store.test/apps/ai-agent/chat**", (r) => r.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "Too many requests", code: "rate_limited", retryAfterSeconds: 20 }) }));
await page.fill(".ai-commerce-chat-input", "hello again");
await page.press(".ai-commerce-chat-input", "Enter");
await page.waitForTimeout(1200);
const busyText = await page.locator(".ai-commerce-chat-messages").textContent();
check("429 shows the wait message", /Please wait a moment/.test(busyText) && !/couldn't connect/.test(busyText.slice(-200)), busyText.slice(-120));
await page.selectOption(".ai-commerce-chat-lang-select", "hi");
await page.fill(".ai-commerce-chat-input", "phir se");
await page.press(".ai-commerce-chat-input", "Enter");
await page.waitForTimeout(1200);
check("429 wait message in Hindi", /थोड़ा रुककर/.test(await page.locator(".ai-commerce-chat-messages").textContent()));
await page.selectOption(".ai-commerce-chat-lang-select", "en");
await page.unroute("https://store.test/apps/ai-agent/chat**");

// ---- no AI could answer: the widget says so in the shopper's language ----
await page.route("https://store.test/apps/ai-agent/chat**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answer: "I'm having a little trouble connecting right now.", fallback: true, products: [], actions: [] }) }));
await page.selectOption(".ai-commerce-chat-lang-select", "hi");
await page.fill(".ai-commerce-chat-input", "kuch dikhao");
await page.press(".ai-commerce-chat-input", "Enter");
await page.waitForTimeout(1200);
const downText = await page.locator(".ai-commerce-chat-messages").textContent();
check("AI down message is in Hindi when Hindi is chosen", /जुड़ने में थोड़ी दिक्कत/.test(downText) && !/trouble connecting/.test(downText.slice(-160)), downText.slice(-120));
await page.selectOption(".ai-commerce-chat-lang-select", "en");
await page.unroute("https://store.test/apps/ai-agent/chat**");

// ---- every piece of chrome text goes through the translations ----
{
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../../extensions/ai-chat-widget/assets/ai-chat-widget.js", import.meta.url), "utf8");
  const hard = src.split("\n").filter((l) => /(textContent|innerText)\s*=\s*"[A-Za-z]|showStatusAlert\("|addMessage\("[A-Za-z]/.test(l));
  check("no hard-coded English text shown to shoppers", hard.length === 0, hard.slice(0, 3).join(" | "));
}

// ---- no voice guess is ever sent ----
check("chat never sends a voice gender or pitch", chatBodies.length > 0 && chatBodies.every((b) => !("voiceGender" in b) && !("voicePitchHz" in b)), String(chatBodies.length));

await browser.close();
