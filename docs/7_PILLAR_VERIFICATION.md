# 7-Pillar verification (TechStore, real Shopify, real widget)

Last updated 2026-11-17. Environment: TechStore dev store `techstore-3qkasoly.myshopify.com`; Shopify app version **39 is active** (checked with `shopify app versions list`, nothing deployed or released); real Chrome with the installed widget, isolated browser context per journey; local backend behind the tunnel; Bogus Gateway; the owner's own e-mail for every test customer. Order #1028 and the 20-mouse cart were not touched.

**Result: 0 of 7 pillars are VERIFIED. 6 are PARTIALLY verified, 1 is BLOCKED.** The pillar names are kept exactly as in the mission.

| Pillar | Real-widget journeys | Final status | Exact blocker |
|---|---|---|---|
| 1. Greeting & Customer Experience | ~14 (EN, HI, Hinglish, USD+INR, repeat/refine, frustrated, off-topic, unclear input) | PARTIAL | voice greeting/interruption needs a real microphone; returning-visitor greeting not separately tested |
| 2. Product Discovery & Recommendations | ~10 sets (phones, bags, dresses, earbuds, watch, t-shirt, gift, shoes, sold-out/not-sold) | PARTIAL | more categories/misspelling and comparison runs; spelling-mistake search only lightly tested |
| 3. Accurate Product Knowledge | ~5 sessions, ~35 questions | PARTIAL | delivery estimates/shipping times are "not published" by the store (answered honestly, nothing to verify); compare-at price not present in this catalogue |
| 4. Complete Shopping & Ordering | ~12 (COD x6 incl. INR+CHAT20, online x3 paid on Shopify's checkout, cart edge cases, discounts) | PARTIAL | chat-driven online payment re-run after the last fix ends at the payment link (paid through that link in a browser only for service-created drafts) |
| 5. After-Sales & Support | ~8 (OTP lookup, status, cancel COD, cancel paid, partial refund status, complaint, human support, callback) | PARTIAL | chat re-run of "cancel after partial refund" (e-mail OTP limit, working as designed); callback booking is disabled for this store; e-mail inbox receipt unverifiable by me |
| 6. Store-Wise Information Isolation | 0 real second-store journeys | **BLOCKED** | a second development store with this app installed (owner action, see `docs/MULTISTORE_TEST_PLAN.md`). Only the gateway boundary was tested (below) |
| 7. Accuracy & Reliability | ~10 adversarial/failure journeys + 429 outage observed | PARTIAL | provider fallback cannot be verified: no `ANTHROPIC_API_KEY`; Gemini free-tier quota is exhausted for hours at a time |

## Evidence by pillar

### 1. Greeting & Customer Experience
- Greeting is AI-written, time-aware, tells the shopper English/Hindi/Hinglish are fine (shows "..." for 3-5 s while it loads).
- English gift chat, Hinglish phone chat (USD and INR with Shopify's contextual rupee prices), Hindi laptop chat, shoes refine chat (men's -> size 9 -> black -> "show me again"), frustrated shopper (EN and Hinglish), unclear input ("asdfgh", "???"), off-topic (python script refused politely, a joke answered briefly), language switch Hinglish -> English mid-chat. Context kept across turns; no repeated question loop after fixes.
- Fixed: "cheaper" ignored (bras shown after power banks); gift reply with unrelated cards; "show me again" gave no cards or "cart is empty"; cards missing next to a listed product. Tests: `qaFixes`, `priceOrderFollowUp`, `answerCardsAndPhone`, `recentlyShownCards`, `showPreviewGuard`.
- Not tested: voice.

### 2. Product Discovery & Recommendations
- Every card price and variant compared with the Shopify catalogue snapshot and live Admin queries (iPhone 15 variants, Samsung A55 variants, HP backpack $35 cheapest, Savannah dress XS only, earbuds, Lenovo variants).
- Honest "not sold" for PlayStation and gaming mouse; sold-out alternative handling.
- Fixed: "wireless earbuds" answered "only one, sold out" while four were in stock (`probeSoldOutOnly`); budget-guard left a dangling list intro (`textTidy`); assistant added to cart without being asked (`addNeedsRequest`).

### 3. Accurate Product Knowledge
- Verified against Shopify: prices by variant, stock/sold-out by variant, descriptions (48MP yes / 108MP no), discounts equal Shopify's rules, return/warranty/shipping answers say "not published" (the store has none), links and images.
- Fixed: feature questions answered from memory ("no headphone jack") now "the listing does not mention it"; "do you have 100?" now answered from real stock without revealing the count (`quantityCheck`); policy questions no longer alert the owner (prompt rule, live: no `flag_for_owner`).
- Currency: INR contextual prices equal Shopify; Shopify's own rupee rate moved (38,100 -> 38,000) and the agent followed it. Duties: Shopify adds 20% import duty + 18% tax on goods+duty (41.6% in total); the agent reports it as Shopify's figures.

### 4. Complete Shopping & Ordering (Shopify evidence)
- Orders: #1028 (COD, USD), #1029 (COD, INR, CHAT20: discount 7,620, total 43,159.68 = chat figure), #1034/#1035 (COD via chat), #1036/#1037 (online, Bogus, paid on Shopify's checkout page, total equal to the chat quote), each exactly one order; stock fell by 1 and returned on cancel.
- Edge cases (live cart read after each step): out-of-stock variant refused with in-stock alternatives, invalid variant (512GB) refused, quantity 1000 -> cart 20 with an honest message, "make it 3" lowers 20 to 3, remove, negative quantity refused, PREPAID50 refused below its USD 20,000 minimum, unknown code refused, duplicate confirm returns the same order, India shipping Standard free / Express Rs 2,000 (Shopify's presentment price).
- Fixed this round: shipping rate shown in the wrong currency; `shipping_rate` argument name; online-payment loop ("which payment method?" forever, then a payment-link claim with no tool call) -> online payment is selected and the next "yes" creates the Shopify payment link (`onlinePaymentLoop` test; live: real invoice URL returned); 50% prepaid discount applied below its minimum (`prepaidMinimum`); "Done! added" for a capped quantity -> verbatim honest cap message; "make it N" mistaken for an add (`addNeedsRequest`).

### 5. After-Sales & Support
- OTP ownership check (real e-mailed code; I read my own test session's stored hash because I cannot open the mailbox; delivery itself unverified), status/tracking ("not shipped yet"), COD cancel, paid cancel, partial refund answers equal to Shopify ($15 paid, $5 refunded), complaint registered (CMP-5XZ2X6, stored with `shop`, status email_sent), human-support escalation action, callback honestly refused (callbacks are off).
- Webhooks: see `docs/WEBHOOK_DEPLOYMENT_PLAN.md`. Real Shopify `orders/create`, `orders/cancelled`, `refunds/create` delivered (after registering the two missing topics through the Admin API), receipts `done`, Events updated, duplicate delivery ignored.
- Fixed: order status shown in the store currency instead of the shopper's; a cancel after a partial refund kept the remaining money (`isPaidOrder`); cancel claimed without the tool -> the cancel step now runs; analytics event marked cancelled by the chat itself.

### 6. Store-Wise Information Isolation: BLOCKED
Only TechStore is installed (one `StoreIntegration`). Tests that DID run against the real server (they use the app secret to sign requests, so they are simulated Shopify calls, NOT two real stores): unsigned proxy request -> 401; correctly signed request for TechStore -> 200; correctly signed request for a store that is not installed -> 403 "Shop is not connected"; TechStore's signature reused with another shop name -> 401. Everything else in the mission list (cross-store order, customer, product, discount, conversation, knowledge-base and webhook leakage with two real stores) is NOT TESTED.
**Owner action required**: create and install a second development store (steps and the 14-test matrix are in `docs/MULTISTORE_TEST_PLAN.md`), then give me its domain and storefront password.

### 7. Accuracy & Reliability
- Prompt injection refused (no prompt/keys), another customer's orders refused, price pressure ("owner approved $1") refused, "I already paid, confirm my order" answered "no order found", guest order lookup requires OTP, Hindi/Hinglish/English multi-turn.
- No-claim-without-tool guard works and blocked false "placed/cancelled/link" claims; where the model skipped a required tool, the checkout/cancel steps now run deterministically (online payment, cancel). A remaining weakness: the guard's fallback sentence "I cannot confirm that this has been done" can replace a harmless reply (seen once on a complaint follow-up).
- Provider failure: Gemini 429 "quota exceeded" observed many times; the widget said "trouble connecting, your cart is still here", no order/claim was made, no duplicate operations. **Fallback to a second provider is NOT verified** (no Anthropic key).
- Not tested: network interruption in the widget, voice interruption.

## Automated checks
`npm test`: 1275 tests, all pass (see the last run below); `npx eslint .` clean.

## Open items / owner actions
1. Second development store (Pillar 6).
2. A billed Gemini key and/or `ANTHROPIC_API_KEY` (Pillar 7 fallback; also stops the quota outages).
3. Check the inbox for the OTP, confirmation and complaint e-mails.
4. Dev Dashboard webhook logs (sign in) and a decision about the two API-registered webhooks if a deploy is ever approved (`scripts/register-order-webhooks.mjs --delete`).
5. Voice tests need a human with a microphone.

---
## Round 3 (2026-11-17, autonomous run). Owner confirmations accepted: provider fallback tested by the owner, e-mails reached the inbox; microphone excluded.

### Scenarios executed in this round (real widget unless noted) and outcome
| # | Pillar | Scenario | Result | Evidence |
|---|---|---|---|---|
| R3-1 | 2 | Misspelling "samsng galxy a55", Hinglish "aipone 15 kitne ka hai", Hinglish budget mouse, comparison, "best phone camera", "latest iPhone 16" (not sold), "show me a mouse", "phone" | PASS (prices equal Shopify; iPhone 16 honestly absent) | widget transcript |
| R3-2 | 2/7 | "$100" sneakers budget leaked into the next question ("compare Samsung and OnePlus" -> "both over your $100 budget") | FAIL -> FIXED (`budgetScope.js`: a budget carries only to a short refinement; test `budgetScope.test.js`; live agent run: comparison shown) | agent-level re-run |
| R3-3 | 1 | Multi-question message (headphones + return policy + ship to India) | PASS at agent level (3 tools, one answer; "ships to India" equals Shopify `shipsToCountries`); the widget run hit a provider error | agent run x3 |
| R3-4 | 3 | Return/warranty/delivery/shipping charge questions; compare-at price (none exists in this catalogue: data limitation) | PASS: "not published" and "calculated at checkout", no invented dates or periods | widget |
| R3-5 | 7 | Prompt injection, other customer's orders, $1 price pressure, "I already paid, confirm", guest order lookup | PASS | widget |
| R3-6 | 4 | Out-of-stock variant, invalid variant, qty 1000 (cap 20), "make it 3", remove, negative qty, PREPAID50 minimum, invalid code | PASS after fixes (cap message honest; "make it N" lowers; see below) | live `/cart.js` after each step |
| R3-7 | 4 | Failed payments on Shopify's checkout page: Bogus card 2 (declined) and 3 (gateway failure) on a real payment link | PASS: both stayed on the payment page, the draft stayed OPEN, NO order was created; card 1 then created #1038 and `orders/create` was received | Shopify Admin, receipt |
| R3-8 | 4 | 3-item cart + FREESHIPPING2026, Express, then a mid-checkout change to 2 items, COD | FAIL -> FIXED: the code stayed applied after the cart dropped below its minimum (chat said $413, Shopify's total was $433). Now the code is removed with the reason (`cart.js`, test in `addNeedsRequest.test.js`). Live: chat total $433 = Shopify order #1039 total 433.00, shipping Express 20.00, no discount code | Shopify order #1039 |
| R3-9 | 4 | "switch to Express shipping" answered "Standard is selected" (listed the options again) | FAIL -> FIXED (switch made inside `get_shipping_options`; test `onlinePaymentLoop.test.js`); live: "updated your shipping to Express" | widget |
| R3-10 | 5 | Unknown order 9999, lookup "1038"/"#1038", "last order and amount", tracking (none yet), "list my orders" (2 today/4 in 30 days = Shopify), complaint wording twice (no complaint registered without consent), human support | PASS | widget + Shopify |
| R3-11 | 5 | Complaint registered (CMP-5XZ2X6) with consent | PASS | `Complaint` row: shop, order 1036, status email_sent |
| R3-12 | 6 | Unsigned proxy/webhook, non-myshopify shop header, validly signed request for an uninstalled shop, cross-shop webhook carrying TechStore's order name | PASS: 401 / 400 / 403 / processed under the OTHER shop with zero effect on TechStore's event and zero rows for that shop | real server; SIMULATED Shopify requests (signed with the app secret) |
| R3-13 | 6 | Tenant filters in admin queries | PASS by code read: every Event/Conversation/SupportCall filter starts with `shop` | `src/admin/*` |
| R3-14 | 7 | A server CRASH (process exit; nodemon stopped) while handling "wait, make the t-shirts 1 instead of 2" | Not reproduced (replayed the exact request body on a clean server: 200). Added `crash.log` (git-ignored) so the next crash leaves its stack. Cause UNKNOWN | ngrok inspector body replay |
| R3-15 | 5 | Fulfilment/tracking and "cancel after fulfilment" on a real order | BLOCKED: `fulfillmentCreate` is refused ("Protected customer data" / fulfilment scopes). Owner action: fulfil test order #1038 in Shopify admin (any tracking number), then I test tracking and the cancel refusal | Admin API error |

Cleanup verified: #1039 cancelled (VOIDED); other test orders were cancelled earlier. Left open on purpose: #1028 (untouched), #1038 (paid, kept for the fulfilment test), #1032 (partially refunded, open), #1027 (not mine).

### Not run because the Gemini quota was exhausted again (429 on every model, checked repeatedly after 10:12 UTC)
Session refresh / new-visitor continuity in the widget, concurrent and repeated requests, Hindi complaint and Hinglish checkout journeys, more discovery categories, second pass of every Round-3 fix across languages. They are NOT executed, not skipped silently; they only need quota.

### Status after Round 3 (honest)
| Pillar | Status |
|---|---|
| 1. Greeting & Customer Experience | PARTIAL (reload/new-visitor continuity and Hindi multi-turn still to run; voice excluded) |
| 2. Product Discovery & Recommendations | PARTIAL (matrix mostly run; second-pass after fixes pending quota) |
| 3. Accurate Product Knowledge | PARTIAL (store data limits documented: no delivery estimates, no policies, no compare-at prices) |
| 4. Complete Shopping & Ordering | PARTIAL (all journeys run incl. failed payments; chat-driven online payment completion not re-run after the loop fix) |
| 5. After-Sales & Support | PARTIAL (tracking and cancel-after-fulfilment BLOCKED by the fulfilment API) |
| 6. Store-Wise Information Isolation | BLOCKED for the real two-store proof (second store). Everything possible on one store was run |
| 7. Accuracy & Reliability | PARTIAL (one unexplained crash; concurrency not run) |

Automated: 1279/1279 pass, ESLint clean.

---
## Round 4 (2026-11-17). Gemini 429 is not a defect; each test that could not run is marked SKIPPED individually.

| # | Pillar | Scenario | Result | Evidence |
|---|---|---|---|---|
| R4-1 | 2 | Non-LLM search matrix against the live catalogue: exact, partial, misspelled (brand+model, "lapptop"), brand, category, price filter, colour+size, nonexistent, sort asc/desc, 7 catalogue cross-checks (every result exists, price equals Shopify) | 19 PASS / 3 limits: "aipone 15" (the typo corrector keeps the first letter; the LLM layer resolves it, live PASS earlier), "joote" (Hindi word, needs the LLM; SKIPPED at tool level), "Sony WH-1000XM5" returns another Sony product (the chat layer must say the XM5 is not sold; live PASS earlier for similar cases) | `sm.mjs` run |
| R4-2 | 1 | Page reload keeps the conversation (4 messages before and after), a follow-up after reload ("which of those is the cheapest?") answers correctly ($549 Lenovo = minimum), a brand-new visitor does not see the old chat | PASS | real widget |
| R4-3 | 7 | 27 malformed/hostile requests to every proxy route (array/plain-text/invalid JSON, object message, 200 KB, 5000-turn history, null/number history items, string cart, NaN/1e99 cart numbers, array/control-char clientId, `__proto__`, bad query params, GET on POST route) on a clean server | PASS: only 400/413/200/404, server alive, no `crash.log` | `fuzz.mjs` |
| R4-4 | 7 | 120 concurrent chat requests in 4 waves, a third hung up mid-request | PASS: server alive after every wave; the app's own rate limiter answered 429 as designed | `stress.mjs` |
| R4-5 | 7 | The unexplained crash: replayed the exact stored request body on a clean server (200), and replayed the whole turn sequence (apply code, checkout, address, billing, Express, cart reduction with preview guard, show_preview, place_order) with a scripted model against REAL Shopify | NOT REPRODUCED in 3 independent ways. Root cause unknown; `crash.log` now records any uncaught exception/rejection with its stack. Status: OPEN | scripts |
| R4-6 | 7 | Database concurrency: 6 simultaneous identical COD submissions | PASS: exactly ONE order (#1040), the other five answered "processing"; #1040 cancelled afterwards | Shopify Admin |
| R4-7 | 5 | Fulfilment permission investigation | The app has NO fulfilment-order scope: `read/write_merchant_managed_fulfillment_orders` (needed for a merchant-managed location such as "My Custom Location"), and the assigned/third-party variants are all MISSING (installed scopes list). Shopify reports it with a misleading "enable Protected customer data" message. Adding scopes means changing the app configuration and releasing a version: NOT done (not authorised). The owner then fulfilled #1038 in the admin | Admin API |
| R4-8 | 5 | #1038 (FULFILLED, no tracking number) in the real widget after a real OTP: "Can I cancel?" refused as already shipped (twice), "tracking number?" answered fulfilled and shipped, tracking not available; return question answered "no return policy published" and offers the team | PASS; service level: `cancellability` = already_shipped, projection shows the shipment without tracking | widget + Shopify |
| R4-9 | 4 | Chat-generated Shopify payment link: declined card (2) then card 1 -> order #1041 created, `orders/create` received, receipt done | PASS (link created by the agent; payment on Shopify's page) | Shopify Admin, receipt |
| R4-10 | 5/4 | Widget cancel of #1041 after a $5 partial refund (verifies the full refund of the rest) | SKIPPED: Gemini quota (the order stays PARTIALLY_REFUNDED and open; the same cancel was verified at service level on #1037) | |
| R4-11 | 4/7 | Chat-driven online payment completed end to end in ONE conversation (address -> online -> link) | SKIPPED in two attempts: a Gemini 429 dropped one turn mid-conversation and the state diverged. The link step itself passed earlier (agent level, real Shopify) | |
| R4-12 | 1/2/7 | Language switch, ambiguous/repeated messages, unrelated search after a budget, comparison second pass, "incorrect assumption" questions | SKIPPED for the parts that hit 429; the budget-leak and comparison fixes were verified live in Round 3 | |

### Status after Round 4
| Pillar | Status | Why not VERIFIED |
|---|---|---|
| 1. Greeting & Customer Experience | PARTIAL | Hindi multi-turn and language-switch re-runs SKIPPED (quota); voice excluded |
| 2. Product Discovery & Recommendations | PARTIAL | second pass partly SKIPPED (quota); tool-level typo limit documented |
| 3. Accurate Product Knowledge | PARTIAL | verified; store-data limits only (no delivery estimates, policies, compare-at prices). Re-run of the knowledge matrix after the latest fixes SKIPPED (quota) |
| 4. Complete Shopping & Ordering | PARTIAL | R4-11 SKIPPED (quota) |
| 5. After-Sales & Support | PARTIAL | R4-10 SKIPPED (quota); tracking number display not testable (no tracking entered); fulfilment scope missing (owner/release decision) |
| 6. Store-Wise Information Isolation | BLOCKED (real two-store proof needs a second installed store) | everything possible on one store passed |
| 7. Accuracy & Reliability | PARTIAL | one crash not explained (OPEN); concurrency/fuzz PASS |
Automated: 1279/1279, ESLint clean (no code changed in this round except the crash log added earlier).
