# Seven-pillar verification: persistent progress (2026-11-17)

Environment: TechStore (`techstore-3qkasoly.myshopify.com`), isolated browser context (storefront password session copied, own cart), widget in real Chrome over CDP 9222.
INR context: open the storefront once with `?country=IN` (the `/localization` POST returns 404 now). Backend: my own `node server.js` (log `%TEMP%\rt\server.log`).
Scripts: `%TEMP%\rt\p1.cjs <scenario>` (set `COUNTRY=IN` for INR). Screens: scratchpad `p1-*.png`.

## Pillar 1: Greeting and experience
Real browser scenarios run (isolated context, real widget, real Shopify data):
- English gift chat, Hinglish phone chat (USD and INR), Hindi laptop chat, repeat/refinement shoes chat, frustrated-shopper chat.
- Greeting is written by the AI (time-aware, offers English/Hindi/Hinglish); shows "..." for ~3-5 s while loading.
Bugs found and fixed (each with a regression test, then re-run in the real browser):
1. "no not that one, cheaper" after power banks showed bras and backpacks. Cause: `cheaper`, `less expensive`, `lower priced` were not price-order words, and `least/less expensive` was parsed as price_high. Fix `src/tools/shopify/words.js`; tests `test/qaFixes.test.js`, `test/priceOrderFollowUp.test.js`. Live: "Ambrane $15 is our lowest-priced".
2. Gift for a sister who likes music: text recommended earbuds, cards showed women's accessories. Cause: `browseCards` replaced the cards the reply named with the search's category. Fix `src/agent/cardSelection.js`; test `test/answerCardsAndPhone.test.js`. Live: three earbuds cards.
3. "show me again what you found" showed no cards / answered "your cart is empty, nothing to preview". Fixes: `session.recentlyShownCards` + agent finalize adds earlier-shown products the reply names; `show_preview` guard in `handlers/orders.js`; prompt line in `systemPrompt.js`. Tests `test/recentlyShownCards.test.js`, `test/showPreviewGuard.test.js`. Live: cards match the text on every turn.
Evidence of correctness vs Shopify: size-9 claim for Nike/Adidas/Puma/Skechers/Men's Formal checked against the catalogue (all have size 9 in stock); INR "20000 ke andar" answered honestly (cheapest phone Rs 21,900, Shopify contextual price).
Not testable here: real microphone voice.
Transient seen: isolated context was once redirected to the storefront `/password` page (HTTP 302 from the app proxy): a test-environment artefact (dev store password), not an app defect.
Status: PARTIALLY VERIFIED (voice and a full human-length journey in every language remain).

## Open items
- Pillars 2-7: see below as they are completed.

## Pillar 2: discovery (real browser, USD context, scripts p2.cjs; catalogue truth = Shopify snapshot)
Sets run: smartphones (+camera, under $300, brand), laptop backpacks (+cheapest, colours), women's dresses (+budget, size), earbuds (+compare), PlayStation/gaming mouse (honest "not sold"), men's watch (+colour, most expensive), t-shirt (+colour, size, price).
Checked against Shopify: card prices all equal catalogue prices; cheapest backpack ($35 HP) = catalogue minimum; HP backpack colours Black/Grey = variants; Savannah dress only XS in stock = variants; phones under $300 = Redmi 229, Nord 279.
Bugs found and fixed (regression tests added, re-run live):
4. "wireless earbuds": the quick pre-search found only the SOLD-OUT "Wireless Bluetooth Earbuds" and the model said it was the only one while four Bluetooth earbuds are in stock (3 of 4 runs). Fix: prompt warns when every quick match is sold out (`buildProbeBlock`); test `test/probeSoldOutOnly.test.js`. Live 4/4 runs now search and show the in-stock earbuds.
5. A reply was left with an intro to a list that a budget guard had cut ("...items in stock that might catch your eye: Would you like..."). Fix `src/agent/textTidy.js`; test `test/textTidy.test.js`.
6. The assistant put a watch ("black one") and a T-shirt ("size L") in the cart without being asked. Fix: `addRequest.js` guard in `add_to_cart`; test `test/addNeedsRequest.test.js`. Live: cart stays empty on both.
Known small gap: a reply that names an earlier product (e.g. "most expensive watch") sometimes arrives without its card.
Status: PARTIALLY VERIFIED (more categories/languages possible).

## Pillar 3: product knowledge (real browser, USD)
Checked vs Shopify: iPhone 15 Blue/128GB $799 (not the $899 of Black), Pink/256GB $750 in stock, 48MP yes / 108MP no (description), Lenovo RAM 8GB or 16GB, Abyss Blue 8GB out of stock while Abyss Blue 16GB (60) in stock, sold-out Wireless Bluetooth Earbuds, 3 discount rules equal the Shopify rules (CHAT20, FREESHIPPING2026, PREPAID50).
Bugs found and fixed: 7. "Does the Samsung A55 have a headphone jack?" answered "No" from memory (not in the listing) while "waterproof?" correctly said the listing does not say. Prompt rule FEATURE QUESTIONS; live 3/3 now "the listing does not mention it". 8. "Do you have 100 mice?" got "in stock, count not shown" (stock is 20): new `quantity` argument on `check_variant_availability` returns `quantityCheck {requested, canSupply}` without revealing the count; test `test/quantityCheck.test.js`; live: "cannot supply 100".
Status: PARTIALLY VERIFIED.
Automated: 1265/1265, ESLint clean.

## Pillar 4: shopping and ordering (real Shopify, real browser; test orders authorised by the owner)
Real orders placed through the widget (isolated context, test address, owner's own test e-mail):
- #1028 (USD, New York): Ambrane Power Bank Blue x1, COD. Shopify admin: ONE order, total 15.00 USD = chat quote 15.00, tax 0, shipping 0 (Standard), COD/manual gateway, PENDING/UNFULFILLED, ship-to name/address/phone as typed, tag Orbi-AI-Order. Confirmation e-mail: SMTP accepted (MessageId in server log); inbox receipt must be confirmed by the owner. A second "yes confirm" did NOT create a second order (tool returned the existing one).
- #1029 (INR, Mumbai): Men's Classic White T-Shirt L x1 (Rs 38,100), CHAT20, Standard shipping, COD. Chat: CHAT20 saves Rs 7,620, total Rs 30,480 after discount, payable Rs 43,159.68 (Rs 6,583.68 tax + Rs 6,096 "further tax/duties not itemised by Shopify", 41.6% of the order: the chat says so plainly). Shopify admin order: discountCodes [CHAT20], discount 7,620.00, subtotal 30,480.00, tax 6,583.68, shipping 0, total 43,159.68 INR = chat figure. One order.
- Shipping in INR (live): Standard FREE, Express Rs 2,000 (the earlier fix; Shopify's own presentment price).
Bugs found and fixed: 9. "switch to Express shipping" answered "that option isn't available for this address. Available: Standard, Express." because the model sent `shipping_rate` and the tool reads `shippingRate`. Fix `camelCaseArgs` in `src/agent/toolSchema.js` (applied to every tool call); test `test/camelCaseArgs.test.js`. NOT re-run live (provider quota, see blockers).
Not done / still open for Pillar 4: online (prepaid) payment path with the Bogus Gateway; the Express order placed end to end; PREPAID50 order (needs a USD 20,000 cart); free-shipping order; stock decrement check; cart re-pricing after cart edits during checkout.
Status: PARTIALLY VERIFIED (cart, discounts, shipping, tax explanation, COD order, duplicate protection are verified on real Shopify; online payment is not).

## Pillar 7 evidence so far
- ROOT CAUSE of "trouble connecting": the Gemini API key's quota. Direct call with the key: 429 "You exceeded your current quota" on gemini-3.1-flash-lite, gemini-3.5-flash-lite and (after a few dozen calls) gemini-3.5-flash; 404 on gemini-2.5-flash (retired for new users). The app handles it honestly (never places or claims anything; says "trouble connecting, your cart is still here"), pauses the model for the time the server asked, and has no second provider (ANTHROPIC_API_KEY is not set, LLM_SECONDARY=claude has nothing to call). A billed Gemini key and/or an Anthropic key is required for production.
- Honest failure behaviour verified live: with the provider down, "place the order" was NOT acted on; "An email address is required..." / "trouble connecting" came back, cart intact, no order created.
- Retries: tool side effects are protected by the turn ledger (earlier fix BUG-08) and by the order idempotency key (second place_order returned the existing order).

## BLOCKED / external dependencies (exact reasons)
1. LLM quota exhausted on the only configured key: every chat-driven journey that needs the model (the rest of Pillar 4, Pillar 5 chat flows, Pillar 1-3 re-runs after the last fixes) is blocked until the quota resets (daily) or a billed key is supplied.
2. Pillar 6 on two real stores needs a second development store installed with this app (Shopify Partner action + the OAuth install through the app URL); not done.
3. E-mail inbox receipt (confirmation, OTP) can only be confirmed by the owner (no mailbox access here).
4. Voice with a real microphone.
5. Release of widget fixes to shoppers needs a Shopify app release: NOT done (deploy forbidden until the owner approves).
Automated: 1267/1267 tests pass, ESLint clean.
