# Audit findings and progress (running file)

Status words: SUSPECTED = read in code, not yet proven by a test. CONFIRMED = a failing test or run proves it. FIXED = fix + regression test in place.

## Baseline (VERIFIED)
- `npm run lint`: clean. `npm audit --omit=dev`: 1 high (mongoose 8.0.0 to 8.24.6). Node v24.15.0.
- Disk: C: 3.37 GB free, D: 54 GB free. No leaked `orbi-mongo-*` folders. An unrelated `mongod` (PID 4740) is running: leave it.

## Files fully read
server.js, routes/shopifyWebhookRoutes.js, routes/shopifyOAuthRoutes.js, routes/shopifyProxyRoutes.js, routes/uploadRoutes.js,
utils/tokenEncryption.js, http/hardening.js, http/storefrontCors.js, voice/voiceAuth.js, services/voiceTokenService.js,
services/tokenReplay.js, services/customerContext.js, services/attachmentService.js, services/objectStorage.js,
services/malwareScan.js, services/storeIntegrationService.js, services/shopifyTokenService.js, services/dataPrivacy.js,
admin/settings.js, agent/agent.js (lines 1 to 1029 so far).

## Findings
| id | severity | where | what breaks | status |
|----|----------|-------|-------------|--------|
| S1 | high (compliance) | services/dataPrivacy.js | `eraseCustomer` / `exportCustomer` / `eraseShop` skipped Complaint, SupportCall, SupportRecording, SupportPresence, VoiceSession, EmailOutbox, WebhookReceipt, ReplyLedger. | FIXED. Proof: test/privacySupport.test.js (4 tests failed before, pass now, real temp Mongo) |
| S2 | medium | routes/shopifyOAuthRoutes.js, services/storeIntegrationService.js | a late retry of an old uninstall webhook switched off a store that was installed again. | FIXED (uses `X-Shopify-Triggered-At` against `installedAt`). Proof: test/auditBatch1.test.js |
| S3 | high (customer data) | services/customerContext.js `resolveClientId` | when the browser sent no client id, a signed-in shopper got `sha256(shop:customer gid)`. That is a valid client id that anyone knowing the store and a customer number can compute and send, reaching that customer's email-verified order lookup (`ol:` session). | FIXED (keyed with the app secret). Proof: test/auditBatch4.test.js (failed before, passes now). Side effect: signed-in shoppers whose widget sent no id start a fresh chat thread once; old rows expire by retention |
| S4 | low | server.js voice socket | a malformed `clientId` from the browser was accepted. | FIXED (`nextClientId`). Proof: test/auditBatch1.test.js |
| S5 | info | routes/shopifyProxyRoutes.js `/chat` | browser history and checkout are already checked (reply ledger, `sanitizeBrowserCheckout`, `normalizeCartSnapshot`). | VERIFIED by reading; cart prices in handlers still to check |
| S6 | medium | routes/shopifyOAuthRoutes.js | `/token-exchange` (and the app entry URL) took the shop from the body and only decoded the session token: any made-up token went on to Shopify, and the store row would be written if Shopify ever accepted it. | FIXED (signature, audience, expiry and shop checked with `verifySessionToken` before any call; 401 for a bad token). Proof: test/auditBatch4.test.js. Left as is: `oauthCors` reflects any origin with credentials (low: no cookie auth anywhere, VERIFIED by search); `getBaseAppUrl` trusts `x-forwarded-host` only when `APP_URL` is unset (set `APP_URL` in production) |
| S7 | low | shopifyTokenService.js, objectStorage.js, server.js | refresh de-dupe is per process; S3 requests have no timeout; `uncaughtException` exits with code 0. | SUSPECTED |
| S8 | dependency | package.json | mongoose high-severity advisories. | FIXED (8.24.5 to 8.24.9; `npm audit`: 0) |
| S9 | medium | server.js sweeper, services/attachmentService.js | call recordings kept in object storage were never removed when their time was up. | FIXED (`sweepExpiredRecordings`). Proof: test/privacySupport.test.js |

Batch 1 result: lint clean, full `npm test` 1051 pass, 0 fail.


Batch 2 and 3 (agent behaviour, found on the real dev-store catalog with the real model and in the browser):

| id | severity | where | what breaks | status |
|----|----------|-------|-------------|--------|
| S10 | high (wrong products) | industries/ecommerce/handlers/catalog.js | a search for a child ("shirt for my son") was turned into a men's search by the shopper's remembered gender. | FIXED. Proof: test/auditBatch2.test.js (failed before, passes now); evaluation kids-clothes now returns the boys' shirt |
| S11 | medium | agent reply path (`echoableQuery`) | the shopper's own words could be echoed back as a product query in the reply. | FIXED. Proof: test/auditBatch2.test.js |
| S12 | medium | agent/modelHealth.js, agent/agent.js | when every Gemini model was paused after a quick "busy" (503) answer, the turn gave the connection-trouble line at once instead of trying again. | FIXED (`busyOnly` probe). Proof: test/rateLimitRetry.test.js |
| S13 | medium (latency) | agent/agent.js `generateText` | side calls (meaning match, same-kind check, suggestions) always used the light model, even while it was answering "busy": one search waited 8 to 11 s for nothing. | FIXED (side calls follow model health and move to a healthy model). Proof: test/rateLimitRetry.test.js |
| S14 | high (false statement) | agent/factGuard.js `claimsCartChange` | "I have added X ($19.00) to your cart" passed the guard when add_to_cart had only asked for a colour: the decimal price split the sentence. Seen in the browser. | FIXED. Proof: test/cartClaimGuard.test.js; browser run shows the guard catching it |
| S15 | low | agent/factGuard.js `claimsCartChange` | an offer such as "Shall I put them in your cart?" counts as a claim and costs one needless rewrite call. | CONFIRMED, not fixed |
| S16 | high (regression from S13, caught in the browser before release) | agent/agent.js `generateText` | a side call that ran out of its own short time paused the model for the main chat: "hi" got the connection-trouble line in 0.2 s. | FIXED (a side-call timeout is not recorded as a model failure; both tries share one time budget). Proof: test/rateLimitRetry.test.js |
| S17 | high (latency) | agent/agent.js Gemini loop | a slow first-choice model held the shopper for the full timeout while a healthy model was next: "hi" took 22 s in the browser. | FIXED (`GEMINI_FAILOVER_TIMEOUT_MS`, default 7000). Proof: test/failoverTimeout.test.js; browser "hi" 3 to 9 s afterwards |

Behaviour changes (prompt and tool results, no word lists): the canned "Here are the best options available..." sentence is no longer handed to the
model when products are found; the model is told to lead with the best fit and one true reason; a short "before you send" check (friend tone, best pick
first, at most one question); "the cheapest one / woh wala" is resolved from the products already shown; a search with a price limit states that every
listed product is within it (`withinBudget`).

Result after batch 3: lint clean, full `npm test` 1062 pass, 0 fail.

## Answer quality fixes (batch 5, found by reading every evaluation reply)

| ID | What the shopper saw | Fix | Test | Status |
|---|---|---|---|---|
| S18 | A snowboard card under an iPhone price answer | `src/agent/cardSelection.js`: a product no tool returned gets a card only when the reply says its name as a run of words | `test/auditBatch5.test.js` | FIXED, VERIFIED |
| S19 | "kuch sasta dikhao" answered with "the store does not stock this" while the shirt was on screen | `handlers/catalog.js`: a price limit nothing meets returns `over_budget` with the lowest priced item | same file | FIXED, VERIFIED on real model |
| S20 | Hinglish answered in English after a tool ran; Devanagari answered in Roman letters | `core/toolsNode.js`: last tool result repeats the shopper's own words to mirror; `services/language.js` `missedDevanagariReply` + rewrite in `agent.js` (script check only, no word list) | same file | FIXED, VERIFIED on real model (gift-hinglish, not-sold, recommend-hindi) |
| S21 | "delivery kitne din me hoti hai?" answered only about shipping charges | `handlers/catalog.js` `get_shipping_options` no-address wording covers time and charges | same file | FIXED, VERIFIED on real model |
| S22 | Price spelled in words; reply that is one lone bullet | Prompt FORMAT rules (digits; one fact is a plain sentence) | none (prompt only) | PARTLY: prices now digits; a lone bullet still appears sometimes |

Still open (seen in run `after5`): a Hinglish follow-up with no tool call can still get English (`price-truth` turn 2); an over-budget suggestion named in the reply shows no card (`gift-hinglish` turn 2); "boys sneakers" shows unisex sizes without saying so.

## Measurements (real model, real dev-store catalog, 18 conversations, 37 turns)
| | before | after |
|---|---|---|
| turns that ended in the connection-trouble line | 8 of 37 | 2 of 37 |
| replies with two or more questions (29 turns answered in both runs) | 2 | 0 |
| main model calls per turn / side calls per turn | 1.79 / 0.41 | 1.83 / 0.38 |
| turn time p50 / p95 (answered turns) | 4.1 s / 11.5 s | 5.6 s / 14.7 s |
| cost per conversation (list prices in scripts/eval-agent.mjs) | $0.0028 | $0.0042 |

Read these honestly: the number of model calls per turn did not change, so the code is not slower. The provider was slower during the second run
(gemini-3.5-flash-lite p50 1.5 s then, 2.8 s now, p95 2.3 s then, 10.3 s now) and gemini-3.1-flash-lite was failing more, so 55 of 76 calls went to
gemini-3.5-flash-lite, which gave almost no cached tokens (20 k of 653 k input tokens; 3.1 gave 58 k of 150 k). Fewer failed turns also means more
paid turns. So: reliability and reply quality are proven better; a latency or cost gain is NOT proven. Every call sends about 12.5 k input tokens
(system prompt + 24 tool definitions): that is the real cost and latency lever (see Next). Voice time-to-first-audio was not measured.

Browser check (Playwright, widget on a local page against the app on a spare port, real dev store, desktop and phone size): greeting, product search
with cards, colour question before adding, Hinglish gift request with a dollar limit, "PS5 hai kya?" (honest "not available" in Hinglish), upset
shopper (apology first, then `request_human_support`). The real cart add cannot be checked on a local page (no Shopify `/cart/add.js`).

## Latency leads (not measured yet)
- `StoreIntegration.exists` on every proxy request; three Mongo-backed rate-limit writes; sequential awaits before the agent in `/chat`;
  `resolveShopifyCustomer` every turn; `openComplaintForChat` awaited serially in `runAgentWithProvider`;
  `finalizeNode` can add several extra model calls (rewrites, `checkSubstitutes`).

## Hardcoding leads
- agent.js: error-message regexes for retry (acceptable: provider errors), price regex in lookup-failed guard.
- factGuard.js / requestGuards.js: `claims*`, `asksForPerson`, `asksToAddToCart`, `languageRequestedBy` (to read).
- tools/shopify/words.js (471 lines), historyHints.js, replies.js, `resolveShoppingGender` (to read).

## Next
1. Owner decision: make gemini-3.5-flash-lite the first model and move to a paid Gemini quota (the free quota gives 429 in normal testing).
2. Cut the 12.5 k input tokens per call: explicit context cache for system prompt + tools, and fewer tool definitions per turn; measure on the evaluation set.
3. Measure voice time-to-first-audio per stage.
4. Hardcoding: conversationProfile.js, tools/shopify/words.js, historyHints.js, requestGuards.js; replace only where the evaluation shows no drop.
5. S15, S3, S6, S7; vague requests ("i need something nice") should get one question before products.
