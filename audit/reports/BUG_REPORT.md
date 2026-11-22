# Bug report

The audit itself changed nothing. Fixes marked FIXED below were implemented afterwards, one by one, and say how they were verified: **unit/agent tests with a scripted model prove the deterministic logic only; none of them proves the real Gemini model's behaviour (its quota was exhausted).** Items marked NOT FIXED are still open. Each item gives what is wrong, where, the evidence, the cause, the impact and the fix or suggested fix.

## BUG-01 [HIGH] Prices shown with the wrong currency sign (a USD store's $429 written as ₹429)

- **Confidence:** verified on the real store
- **Test cases:** W-price-iphone15, W-hindi, W-network-drop-and-recover
- **Affected file and function:** `src/agent/agent.js: runAgentInner (storeCurrency seeded from the browser cart)`; `src/industries/ecommerce/systemPrompt.js: currencyRule and the AMOUNTS rule (hardcoded '₹1,500')`; `src/agent/factGuard.js: toCents / verifyReplyFacts (compared numbers only)`
- **Reproduce:** open the real TechStore storefront from an Indian IP -> ask for a price in Hindi
- **Evidence:** Real storefront run: 2 of 11 replies with a price used ₹ (Hindi reply '₹429.00', an English reply '₹69.00') on a store whose live currency is USD; the other 9 used $.
- **Root cause:** The store currency fell back to the visitor's cart currency (INR for an Indian visitor) when the catalog summary was late; the prompt then told the model the amounts were 'already in the customer's currency' although prices are always in the store's currency (STORE_PRICES_FOLLOW_MARKET is off); the prompt example was a rupee amount; the fact guard stripped the sign and compared only the number.
- **Impact:** A customer may read ₹429 for a $429 product.
- **Recommended fix:** FIXED: store currency only from Shopify; the customer-currency rule only with STORE_PRICES_FOLLOW_MARKET=1; prompt example from the store currency; factGuard replaces a wrong sign (never the amount); hardcoded USD/INR defaults removed (cards, widget, offers). Verified by unit tests only (13 tests in test/shopperCurrency.test.js); not re-run on the real model.
- **Status:** fixed (see the fix above for how it was verified)

## BUG-06 [HIGH] Complaint workflow: the same question asked four times, no complaint offered, a person called without consent

- **Confidence:** verified (transcript)
- **Test cases:** K02
- **Affected file and function:** `src/services/complaintService.js: complaintPromptBlock / recordIssue`; `src/industries/ecommerce/handlers/complaints.js: track_issue, raise_complaint`; `src/industries/ecommerce/toolDefinitions.js: raise_complaint (channel was required)`
- **Reproduce:** 'My order arrived damaged' -> 'The screen is broken' -> 'I already told you the issue' -> 'Why are you asking again?' -> 'Raise a complaint'
- **Evidence:** The order number or email was asked in 4 of the first 4 replies; the complaint was never offered when the problem was repeated; 'Raise a complaint' connected a person without asking email-or-person.
- **Root cause:** The stage text kept saying 'solve it now'; nothing recorded what had already been asked; the tool let the model choose the channel itself.
- **Impact:** Angry customers are asked the same thing repeatedly and may be put through to staff without consent.
- **Recommended fix:** FIXED in the backend: a per-complaint counter of customer messages about the problem; a record of the details already asked (askingFor); raise_complaint acts only after the email-or-person choice was offered in an EARLIER customer message; the prompt block follows these facts. 11 new/changed tests with a real temporary MongoDB. The real model's use of it is not re-run.
- **Status:** fixed (see the fix above for how it was verified)

## BUG-07 [HIGH] An empty answer from Gemini was shown as 'connection trouble' without trying Claude

- **Confidence:** found by a new test, verified
- **Test cases:** UT-provider-empty
- **Affected file and function:** `src/agent/agent.js: finalizeNode (empty text became FALLBACK_ANSWER, which the provider loop accepted as an answer)`
- **Reproduce:** Gemini returns no text twice in a row, Claude is configured
- **Evidence:** Before the fix the turn ended with the connection-trouble line and Claude was never called (log shows no 'trying provider=claude').
- **Root cause:** The fallback line is a non-empty string, so runAgentInner returned it as the first provider's result.
- **Impact:** Any empty model response bypassed the secondary provider.
- **Recommended fix:** FIXED: an empty reply with no verified tool output is raised as a provider failure so the next provider takes the turn. Unit-tested with fake clients.
- **Status:** fixed (see the fix above for how it was verified)

## BUG-08 [HIGH] A provider failing after a write tool could make the next provider run the tool again

- **Confidence:** found by code review, verified by unit test
- **Test cases:** UT-ledger
- **Affected file and function:** `src/agent/agent.js: runAgentInner (provider loop)`; `src/agent/core/toolsNode.js: toolsNode`
- **Reproduce:** provider A runs raise_complaint / book_call / send_order_otp and then times out; provider B repeats it
- **Evidence:** Code path: every provider restarts the whole turn with a new session; no ledger existed.
- **Root cause:** Tool results lived in a per-attempt session.
- **Impact:** A duplicate complaint, booking, call or e-mailed code.
- **Recommended fix:** FIXED: a per-turn side-effect ledger returns the earlier result (and its actions) instead of running the tool again. 2 unit tests.
- **Status:** fixed (see the fix above for how it was verified)

## BUG-02 [MEDIUM] Recommendations above the shopper's stated budget

- **Confidence:** verified (transcripts)
- **Test cases:** B01, L03, A09, B02
- **Affected file and function:** `src/tools/shopify/search.js: probeCatalog (ignored the budget)`; `src/agent/agent.js: finalizeNode (no check of named products against the budget)`; `src/tools/shopify/words.js: parseSearchFilters (English phrases only)`
- **Reproduce:** ask 'best phone for gaming under 30000'
- **Evidence:** B01: the iPhone 15 (71600) and Galaxy A55 (41000) were listed and shown as cards for a 30000 budget. L03: a 7600 bag for '4000 ke andar'. A09 passed in the first run and failed in the second: the behaviour varies between runs.
- **Root cause:** The quick pre-search handed the model every match without the budget; the budget parser understood only English; nothing checked the prices of the products the reply names.
- **Impact:** Customers are recommended products they said they cannot afford.
- **Recommended fix:** FIXED: the pre-search applies the budget (same helper as the search tool); Hindi/Hinglish budgets parsed; a guard rewrites a reply that names an over-budget product once and removes those cards, not applied when the tool itself says nothing fits. Unit/agent tests with a scripted model; real model not re-run.
- **Status:** fixed (see the fix above for how it was verified)

## BUG-03 [MEDIUM] The assistant quotes prices taken from the browser's cart

- **Confidence:** verified (transcript + code)
- **Test cases:** I07
- **Affected file and function:** `src/services/cartSnapshot.js: normalizeCartSnapshot (trusts price and line_price)`; `src/services/cartPricing.js: cartInStoreCurrency (re-prices only when the currency differs)`
- **Reproduce:** send a cart snapshot with a price of 1.00 for an iPhone 15 -> ask 'what is my cart total?'
- **Evidence:** The agent answered 'Your cart total right now is $1.00 for the Apple iPhone 15'.
- **Root cause:** The cart total the assistant states is computed from browser-supplied minor-unit prices. The real order is NOT affected: place_order builds the draft order from variant id and quantity only and Shopify prices it (shopifyOrderService.js), and a product that is not ACTIVE and published is refused (line 369).
- **Impact:** Wrong total quoted to the customer who edited their own request; no financial effect on the store.
- **Recommended fix:** FIXED: cartInStoreCurrency now also checks a cart that arrives in the store's own currency: any line whose list price differs from Shopify's variant price is priced from Shopify and the cart carries priceCorrected: true. A variant Shopify does not return is left as sent (nothing is guessed). Test: test/cartPricing.test.js (BUG-03). Limit: the lookup is cached 60 s and a failed Shopify call leaves the browser's cart as it was; the real order is priced by Shopify either way.
- **Status:** fixed (see the fix above for how it was verified)

## BUG-04 [MEDIUM] The chat can open completely empty

- **Confidence:** verified on the real store
- **Test cases:** W-greeting-and-chat-opens
- **Affected file and function:** `src/routes/shopifyProxyRoutes.js: POST /greeting (returns an empty greeting on failure)`; `src/agent/agent.js: generateGreeting (6 s budget)`; `shopify-app/extensions/ai-chat-widget/blocks/ai_chat_widget.liquid: fallback_greeting (no default)`
- **Reproduce:** open the widget on the real storefront while the model is slow
- **Evidence:** Real storefront screenshot: an empty panel; server log '[greeting] gemini failed: This operation was aborted'.
- **Root cause:** The AI greeting timed out, the server answered empty, and the widget had no default of its own.
- **Impact:** A first-time visitor sees no greeting and no suggestions.
- **Recommended fix:** FIXED: the widget shows the merchant greeting or a short default in English/Hindi; the server keeps an anonymous greeting per store/language/part of the day for 20 minutes, so fewer model calls. Browser-test verified.
- **Status:** fixed (see the fix above for how it was verified)

## BUG-05 [MEDIUM] Off-topic requests answered (a Python function was written)

- **Confidence:** verified (real store + sandbox)
- **Test cases:** D01, D02, W-off-topic
- **Affected file and function:** `src/industries/ecommerce/systemPrompt.js: STAY IN YOUR LANE (list did not include coding or trivia)`; `src/agent/agent.js: finalizeNode (no check)`
- **Reproduce:** ask 'Write a Python function to reverse a string.'
- **Evidence:** Both in the sandbox and on the real storefront the agent wrote the code.
- **Root cause:** The scope list named medical/legal/politics/religion only; nothing outside the prompt enforced it.
- **Impact:** The store pays for a general-purpose assistant, and answers are off-brand.
- **Recommended fix:** PARTIALLY FIXED: prompt rewritten (coding, homework, trivia, advice are not its job; questions that help choose a product, such as 'what is RAM', stay allowed) and a language-free guard rewrites any reply that contains a code block, then cuts the code. Trivia such as 'capital of Australia' relies on the prompt only and is NOT verified on a real model.
- **Status:** fixed (see the fix above for how it was verified)

## BUG-09 [MEDIUM] A request to SEE a kind of product shows one card

- **Confidence:** found on the real store, partly verified
- **Test cases:** UT-browse
- **Affected file and function:** `src/agent/cardSelection.js: cardsForAnswer (cards limited to products the reply names)`; `src/industries/ecommerce/systemPrompt.js`
- **Reproduce:** 'show me jeans' / 'ek jeans dikhao' with six jeans in the store
- **Evidence:** The search returned 6 of 6 jeans (verified without AI); real server log: '[cards] answer names 1 of 6 found products'.
- **Root cause:** The cards follow the model's wording.
- **Impact:** Shoppers see no choice.
- **Recommended fix:** FIXED deterministically: for a category search the cards are the products that search returned for that kind (named ones first), within budget, without duplicates; a request about one product, or a cheapest/most-expensive request, keeps only what the reply names. Agent-level tests with a scripted model; the real model not re-run.
- **Status:** fixed (see the fix above for how it was verified)

## BUG-10 [MEDIUM] The assistant's prices (store currency) differ from what the page shows to a visitor in another market

- **Confidence:** verified on the real store
- **Test cases:** W-price-iphone15
- **Affected file and function:** `src/services/cartPricing.js (by design: header comment)`
- **Reproduce:** open the storefront from India: the page shows 'Rs. 62,200.00'; the assistant says $…
- **Evidence:** Screenshots 06/07 of the real storefront run.
- **Root cause:** By design every amount is in the store's own currency (STORE_PRICES_FOLLOW_MARKET off).
- **Impact:** Different numbers and currencies in the chat and on the page; the checkout price in the visitor's market was NOT verified.
- **Recommended fix:** DECIDED, not changed: every amount the assistant says or shows stays in the store's own (Shopify base) currency, the only price the backend can verify. Market prices were not used because they could not be verified: the real store's access token has expired and the refresh token must not be used, so the store's Markets setup could not be read, and a market price is never derived by converting. STORE_PRICES_FOLLOW_MARKET=1 exists but is untested against a real market. Limit: a visitor in another market sees the page in their currency and the chat in the store's currency, with the code shown by the widget; the checkout price in the visitor's market was not verified. Merchants selling in several markets should know this before launch.
- **Status:** open by decision (documented limitation). Code-level: every amount in the chat stays in the store's Shopify currency; the order service prices a cart in another currency only from Shopify's own contextual price for the shopper's country and refuses it ("refresh the page", reported to the shopper as a cart-price change) when that price or the currency cannot be confirmed. A fixed-amount discount is also refused on a cart in another currency (defence in depth, test in test/shopifyOrderService.test.js); no conversion is done anywhere. Exact limitation: docs/PRODUCTION_CHECKLIST.md section 7. Mock-tested only; a Markets checkout was never run against a real store.

## BUG-11 [LOW] Three separate Shopify GraphQL clients and five API-version constants

- **Confidence:** verified (code)
- **Test cases:** S12, S13
- **Affected file and function:** `src/services/shopifyAdminService.js`; `src/services/shopifyCustomerService.js`; `src/tools/shopify/client.js`
- **Reproduce:** static scan
- **Evidence:** S12, S13.
- **Root cause:** Grown over time.
- **Impact:** A fix to timeouts or errors can miss one client.
- **Recommended fix:** NOT FIXED on purpose (launch day): a refactor to one client touches every Shopify call and has no customer-visible effect. Tracked as a maintainability task.
- **Status:** partly fixed. The five API-version constants are now one (`shopifyApiVersion()` in src/config/env.js). The shared client (shopifyAdminService.js) now retries throttled/5xx reads and throttled writes and never repeats a write that may have run (test: test/shopifyOrderService.test.js). The three clients themselves were not merged (maintainability only).

## BUG-12 [LOW] OAuth routes reflect any origin with credentials

- **Confidence:** verified (code)
- **Test cases:** S10
- **Affected file and function:** `src/routes/shopifyOAuthRoutes.js:19-21 (cors origin: true, credentials: true)`
- **Reproduce:** static scan
- **Evidence:** S10.
- **Root cause:** Written for the Shopify admin iframe.
- **Impact:** Not exploitable today because the routes use bearer session tokens, never cookies.
- **Recommended fix:** FIXED: credentials: false on the OAuth CORS policy (the routes use bearer tokens; the state cookie is read only on top-level navigations). Test: test/hardening.test.js (BUG-12). The origin is still reflected, which is harmless without credentials.
- **Status:** fixed (see the fix above for how it was verified)

## BUG-13 [LOW] Widget kept customer details on the device after the shopper left

- **Confidence:** verified
- **Test cases:** S14, stale-customer
- **Affected file and function:** `shopify-app/extensions/ai-chat-widget/assets/ai-chat-widget.js: initCustomerIdentity`
- **Reproduce:** log in, log out on a shared computer
- **Evidence:** Browser test stale-customer.mjs fails without the fix.
- **Root cause:** Saved details were restored when the page showed no login.
- **Impact:** The next visitor's chat could carry the earlier customer's name and email as a guest hint (never as a login).
- **Recommended fix:** FIXED earlier in this engagement and browser-test verified.
- **Status:** fixed (see the fix above for how it was verified)

## BUG-14 [LOW] Text chat refused to send when the backend address could not be resolved; long input gave a misleading error

- **Confidence:** verified
- **Test cases:** chat-without-backend-url, slow-greeting-and-long-input
- **Affected file and function:** `shopify-app/extensions/ai-chat-widget/assets/ai-chat-widget.js: submit handler`; `ai_chat_widget.liquid (no maxlength)`
- **Reproduce:** no 'Chat backend URL' setting and a proxy lookup that fails
- **Evidence:** Browser tests fail without the fixes.
- **Root cause:** Text chat does not use the backend address.
- **Impact:** Chat dead or a wrong error.
- **Recommended fix:** FIXED earlier in this engagement and browser-test verified.
- **Status:** fixed (see the fix above for how it was verified)


## BUG-15 [HIGH] Cancelled Shopify orders kept counting as orders and revenue

- **Confidence:** verified (code + real-database test)
- **Affected file and function:** `src/routes/shopifyWebhookRoutes.js` (only orders/create was subscribed); `src/admin/stats.js: overview, ordersByPerson, person spend`
- **Root cause:** an order was counted once when placed and never un-counted.
- **Impact:** the dashboard's revenue, order count, average order value and per-customer spend included orders the store had cancelled.
- **Fix:** new `orders/cancelled` webhook (TOML, server.js, `markOrderCancelled`): marks that store's event only, once; the stats exclude marked events; the Orders list still shows the order, labelled Cancelled from Shopify's own status. A create delivery that arrives late for an already cancelled order is recorded as cancelled. Needs `shopify app deploy` to register the subscription. Tests: test/oneChatPerPerson.test.js, test/privacy.test.js.
- **Status:** fixed (mocked webhook payloads, real database; not run against a real Shopify)

## BUG-16 [MEDIUM] A payment link whose draft order was deleted in Shopify was handed out again

- **Affected file and function:** `src/services/shopifyOrderService.js: createShopifyAdminOrder (replay of a payment_required result)`
- **Fix:** when Shopify no longer has the draft, the order is first looked up by the request's tag (the shopper may already have paid: that order is returned, never a second link); only if no order exists is the stored result retired and a fresh payment draft created. A paid draft still returns the real order; an unpaid one the same link. Tests: test/shopifyOrderService.test.js.
- **Status:** fixed (mocked Shopify answers)

## BUG-17 [MEDIUM] Some checkout refusals were explained as "the store could not confirm, try again"

- **Affected file and function:** `src/services/checkoutMessages.js: checkoutFailureReason`
- **Root cause:** the patterns did not match the service's own messages ("different currency", quantity over 50, empty cart, conflicting prices).
- **Fix:** patterns matched to the real messages, new reason `cart_needs_changes`; a test drives every refusal through the real service. 
- **Status:** fixed

## BUG-18 [MEDIUM] Shopify throttling or a brief 5xx failed a read at once

- **Affected file and function:** `src/services/shopifyAdminService.js: adminGraphql`
- **Fix:** up to three attempts for reads (throttled, 5xx, timeout) and for writes Shopify says it did not run; a write that may have run is never repeated. Test with a real database and scripted HTTP: test/shopifyOrderService.test.js.
- **Status:** fixed

## BUG-19 [HIGH] Refunds never lowered revenue, and a cancel processed before its create left the order counted

- **Confidence:** verified (code + real-database test)
- **Affected file and function:** `src/routes/shopifyWebhookRoutes.js`; `src/admin/money.js: moneyExpr`; `src/admin/stats.js`; `src/admin/performance.js`
- **Root cause:** an order was counted once at its total and never changed; cancellation was a delta applied only to an event that already existed.
- **Fix:** one rule (checklist section 7): net of Shopify's refund, cancelled and fully refunded orders do not count. Every order webhook (orders/create, orders/cancelled, new refunds/create) makes sure the event exists and then writes Shopify's CURRENT state of the order (cancelled, financial status, total and refunded, store currency) onto it, as values never as additions, so duplicates and any order of arrival give the same result. A refund that arrives before its order is recorded is retried by the webhook queue. Overview, order count, customer spend, per-person spend and performance share the same rule. Tests: test/oneChatPerPerson.test.js (create-cancel, cancel-create, duplicates, refund-first, partial and full refunds, a second store), test/admin/money.test.js.
- **Verified with:** scripted Shopify answers and a real database. Not with a real store; Shopify's field names (`totalRefundedSet`, `cancelledAt`, `displayFinancialStatus`, `customAttributes`) are the ones the existing order lookup already uses.
- **Status:** fixed (mock-verified)
