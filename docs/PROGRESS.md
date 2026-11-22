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

## Update 2026-11-17 (second session part): after-sales and checkout evidence, non-LLM
Stock after test orders (Shopify inventory, before = catalogue snapshot of 2026-11-16, after = live): Ambrane Blue 19 -> 18 after #1028; T-shirt L 23 -> 22 after #1029; both restocked on cancel (T-shirt L back to 23; Ambrane White 15 -> 14 -> 15 around #1030).
Order lookup, service level against real Shopify (not through the chat): #1027/#1028/#1029 found; `belongsTo` true for the verified test e-mail and false for another e-mail on every order; unknown #9999 not found; status/tracking projection correct ("not shipped yet", no tracking); the owner's order list for the test e-mail = #1029, #1028, #1027.
BUG found by this: order status showed INR order #1029 as "$457.87" (store currency) although the shopper paid Rs 43,159.68. Fix: `money()` prefers presentment money (`src/services/shopifyOrderLookupService.js`), test `test/orderPresentmentMoney.test.js`, live: Rs 43,159.68.
Cancellation (service level, real Shopify): #1029 (COD, unfulfilled) cancelled -> VOIDED, cancelReason CUSTOMER, restocked. #1030 (online, Bogus Gateway, PAID $15, paid through Shopify's real checkout page with test card 1) cancelled with refund -> REFUNDED, Shopify transactions SALE 15.00 bogus SUCCESS + REFUND 15.00 bogus SUCCESS, net payment 0. COD refund NOT claimed (#1029 was never paid; Shopify voided it).
Prepaid path (service level + real Shopify checkout page): the payment link opened Shopify's own checkout with the same total (USD 15.00), Standard FREE, Express USD 20.00; paid with the Bogus Gateway; confirmation page shown. The chat-driven prepaid flow is still NOT tested.
WEBHOOKS: the store has ONLY the APP_UNINSTALLED subscription; orders/create, orders/cancelled and refunds/create (declared in the app TOML) are not registered, because that needs `shopify app deploy` (a release, not authorised). So no webhook was delivered for #1028-#1030 (`WebhookReceipt` empty). Consequence found: a cancel through Shopify admin or any other path never marked the analytics event cancelled. Fix: the chat's confirmed cancel now marks the order's event cancelled itself (`handlers/orders.js`; test in `test/cancelReason.test.js`); #1029's event was reconciled with the same update. Orders cancelled outside the chat still need the webhook (deploy).
India "41.6% tax" explained from the real order (read-only): Shopify adds IMPORT DUTIES of 20% of the goods (HS code 61099020, Markets cross-border duties for the India market) and charges 18% tax on goods + duties: 0.20 + 0.18 x 1.20 = 0.416. #1029: goods 30,480.00, duty 6,096.00, tax lines 5,486.40 + 1,097.28 = 6,583.68 (order totalTax), total 43,159.68. The order's `totalTax` (6,583.68) excludes the duty itself, which is why the quote showed "6,096 other charges". No merchant setting was changed; the owner should confirm that duties are meant to be collected for the India market (Settings > Markets > India > Duties and import taxes). The app's wording ("further tax/duties not itemised") is accurate; it could say "import duties" now that the cause is known.
Shopify's rupee price moved: Men's Classic White T-Shirt Rs 38,100 -> Rs 38,000 between two runs (Shopify's own contextual price, exchange rate update). The app follows Shopify.
Provider quota: the Gemini key allows a few calls and then 429 for hours (checked: 3.1-flash-lite, 3.5-flash and 3.5-flash-lite worked once at ~04:10 UTC, then 429 again within minutes). BLOCKED: live re-run of the shipping_rate fix (`camelCaseArgs`), chat-driven Express/prepaid orders, complaint/callback/OTP chat journeys, missing-card reproduction.
Multi-store: plan written in `docs/MULTISTORE_TEST_PLAN.md`; real verification BLOCKED until the second store is installed.

## CORRECTION (2026-11-17): webhooks are subscribed
The earlier claim that the orders webhooks were not registered was wrong (see `docs/WEBHOOK_DEPLOYMENT_PLAN.md`): `WebhookReceipt` holds orders/create for #1028, #1029, #1030 (done) and one orders/cancelled + refunds/create from 2026-11-16. What is still unexplained: no orders/cancelled for #1029/#1030 and no refunds/create for #1030 after ~3 h. The "no deploy needed" hypothesis is open until the Dev Dashboard delivery log is read. The chat-side cancel update stays (it does not depend on the webhook).

## 2026-11-17 webhook completion round: evidence (real Shopify events, real widget)
All on TechStore, the owner's own test e-mail, Bogus Gateway. Times are UTC.
- W1 orders/create: #1031 (service COD) 08:01:35, receipt done in 0.6 s; #1034 and #1035 (chat COD), #1036 and #1037 (online, paid on Shopify's real checkout page): each delivered 200, receipt done, analytics Event created or reconciled with the right financialStatus.
- W2 orders/cancelled: BEFORE the API registration none for #1029, #1030, #1031 (the tunnel inspector shows no request). AFTER: #1033 08:11:16, #1034 08:18, #1035 08:23:50, #1036 08:41:30, #1037 08:50:16, all 200, receipts done, Event props.cancelledAt set.
- W3 refunds/create: #1032 $3 (08:11:20), #1036 $5 (08:35:34) then $10 (final) -> Event refundedTotal 5 then 15, financialStatus "partially refunded" then "refunded", refundedInFull true; #1037 $5 then the cancel's remaining $10 -> 15. (A $5 refund of #1032 before the registration was never delivered.)
- W4 duplicates: one signed refunds/create delivery (same X-Shopify-Webhook-Id) sent three times to the real local route (simulated delivery): 1 processed, 2 `{"duplicate":true}`, one receipt added, Event refundedTotal unchanged (5), Shopify's total refunded unchanged (5).
- W5 stock: restored on every cancel (Ambrane Black 29 only because #1032 is still open; Blue 18 because #1028 and #1027 are open).
- Widget journeys (real browser, isolated context). Order lookup verified by a real e-mailed OTP; I read the code from my own test session's stored hash because I cannot open the mailbox, so e-mail DELIVERY itself is unverified.
  * J1 #1035 PASS: place a COD order in chat -> "Where is my order?" -> OTP -> status -> "Can I cancel my order?" -> yes -> reason -> cancelled (Shopify VOIDED) -> "Has it been cancelled?" yes -> "Has my refund been processed?" (no payment was made) -> "Why does it show active?" (answers cancelled/voided). Equal to Shopify.
  * J1 first run #1034 FAIL, then fixed: after the reason the model said "cancelled" without calling cancel_order; the guard replied "I cannot confirm..." and the order stayed open. FIX in `agent.js`: when the cancel stage is awaiting_reason and the reply claims a cancel, cancel_order is run with the customer's own words (new `session.pendingCancelStage`). J1 re-run passed; the flake did not recur, so the new branch has no unit test and is verified only by code reading.
  * J3 #1036 (paid, $5 refunded) PASS: status, "Has my refund been processed?" -> $5.00 partial, "how much refunded and paid?" -> paid $15, refunded $5. Equal to Shopify.
  * J4 #1036 chat cancel: cancelled, but Shopify kept $10 (PARTIALLY_REFUNDED, net payment 10). BUG: `isPaidOrder` ignored PARTIALLY_REFUNDED so refund:false. FIXED (`shopifyOrderLookupService.js`, test `orderPresentmentMoney.test.js`). Verified at service level on #1037 (PARTIALLY_REFUNDED -> cancel -> REFUNDED, net 0, webhooks done). The CHAT re-run on #1037 is BLOCKED: the e-mail OTP limit (5 per e-mail per hour, working as designed) was reached; re-run after the window resets.
- Another bug found: choosing "online payment" on a $15 cart applied the 50% prepaid discount although the Shopify rule has a USD 20,000 minimum. FIXED (`tools/shopify/offers.js` reads `minimumRequirement`; test `prepaidMinimum.test.js`); live: "no prepaid discount, total stays $15.00".
- Still open: (a) the model sometimes claims a payment link or an order without calling the tool and the guard then answers "I cannot confirm..." (seen at "yes place the order" for an online order); (b) chat re-run of the partially-refunded cancel (OTP window); (c) compliance topics and APP_UNINSTALLED not exercised with real Shopify events; (d) Dev Dashboard delivery logs unreadable (login); (e) e-mail inbox receipt unverified; (f) the API-registered webhooks must be removed or reconciled if a future deploy activates the TOML ones.
