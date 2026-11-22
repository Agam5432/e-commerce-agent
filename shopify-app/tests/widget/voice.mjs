import { setup } from "./harness.mjs";
const { page, browser, errors, chatBodies, tokenBodies, check } = await setup();
await page.goto("https://store.test/");
await page.click(".ai-commerce-chat-toggle");
await page.waitForTimeout(400);
const sel = page.locator(".ai-commerce-chat-lang-select");
check("language menu is in the header", await sel.isVisible());
check("menu starts on Auto", (await sel.inputValue()) === "");

// typed message carries the chosen language
await sel.selectOption("hi");
await page.fill(".ai-commerce-chat-input", "tv dikhao");
await page.press(".ai-commerce-chat-input", "Enter");
await page.waitForTimeout(500);
check("typed chat sends the chosen language", chatBodies.at(-1)?.languageChoice === "hi", JSON.stringify(chatBodies.at(-1)?.languageChoice));
await sel.selectOption("en");

// voice
await page.click(".ai-commerce-chat-mic");
await page.waitForTimeout(800);
check("voice socket opened", await page.evaluate(() => Boolean(window.__ws)));
const wsOpen = await page.evaluate(() => ({ url: window.__ws.url, protocols: window.__ws.protocols }));
check("voice token is not in the socket URL", !/token=/.test(wsOpen.url), wsOpen.url);
check("voice token goes in the subprotocol next to orbi.voice.v1", Array.isArray(wsOpen.protocols) && wsOpen.protocols[0] === "orbi.voice.v1" && wsOpen.protocols[1] === "orbi.token.t", JSON.stringify(wsOpen.protocols));
check("the voice token is asked for as a voice token", tokenBodies.at(-1)?.purpose === "voice", JSON.stringify(tokenBodies.at(-1)));
const label = async () => (await page.locator(".ai-commerce-chat-voice-label").textContent()).trim();
check("idle label is Listening, not 'User Speaking'", /Listening/.test(await label()), await label());
await page.evaluate(() => window.__sent.length = 0);
await page.selectOption(".ai-commerce-chat-lang-select", "hi");
const langSent = await page.evaluate(() => window.__sent.map((d) => JSON.parse(d)).find((m) => m.type === "lang_state"));
check("menu change tells the voice server", langSent?.lang === "hi", JSON.stringify(langSent));

const users = () => page.locator(".ai-commerce-chat-user");
const before = await users().count();
await page.evaluate(() => window.__push({ type: "interim", text: "mujhe ek" }));
await page.waitForTimeout(50);
check("live words appear while speaking", (await users().count()) === before + 1 && /mujhe ek/.test(await users().last().textContent()));
await page.evaluate(() => window.__push({ type: "partial", text: "mujhe ek smart tv" }));
await page.evaluate(() => window.__push({ type: "interim", text: "chahiye" }));
await page.waitForTimeout(50);
check("live bubble grows, still one bubble", (await users().count()) === before + 1, await users().last().textContent());
await page.evaluate(() => window.__push({ type: "transcript", text: "mujhe ek smart tv chahiye", runId: 1 }));
await page.waitForTimeout(50);
const last = users().last();
check("final transcript replaces the live text at once", (await users().count()) === before + 1 && (await last.textContent()).trim() === "mujhe ek smart tv chahiye" && !(await last.getAttribute("class")).includes("is-live"));
check("thinking label after the transcript", /Thinking|सोच/.test(await label()), await label());

await page.evaluate(() => window.__push({ type: "lang", lang: "hi" }));
await page.evaluate(() => window.__push({ type: "answer", text: "ज़रूर, ये रहे स्मार्ट टीवी।", runId: 1, products: [], actions: [] }));
await page.waitForTimeout(300);
const spoken = await page.evaluate(() => window.__spoken);
check("reply is spoken", spoken.some((s) => /टीवी/.test(s.text)), JSON.stringify(spoken));
check("an instant device voice is used, not the online one", spoken.every((s) => s.voice !== "Google हिन्दी"), JSON.stringify(spoken.map((s) => s.voice)));
check("menu follows the agent's switch", (await sel.inputValue()) === "hi");

// continued speech after a pause: one bubble, not two
const count2 = await users().count();
await page.evaluate(() => window.__push({ type: "partial", text: "aur 55 inch", continued: false }));
await page.evaluate(() => window.__push({ type: "transcript", text: "mujhe ek smart tv chahiye aur 55 inch", runId: 2, replaceLastUser: true }));
await page.waitForTimeout(50);
check("a continued question replaces the earlier bubble", (await users().count()) === count2, String(await users().count()));

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
