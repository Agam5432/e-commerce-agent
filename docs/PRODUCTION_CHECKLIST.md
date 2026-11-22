# Production checklist

Items marked **(you)** need your accounts, keys or domain: they cannot be done from the code. Nothing below invents a value.

## 1. The three Shopify URLs that still point at the ngrok tunnel
All three are in `shopify-app/shopify.app.ai-commerce-agent.toml`. Each must become the production domain (the same host as `APP_URL`); leave them unchanged until that domain exists.

| Line | Key | Today | Becomes |
|---|---|---|---|
| 3 | `application_url` | `https://<tunnel>` | `https://<production-domain>` |
| 26 | `redirect_urls` | `https://<tunnel>/api/shopify/oauth/callback` | `https://<production-domain>/api/shopify/oauth/callback` |
| 33 | `[app_proxy] url` | `https://<tunnel>/proxy` | `https://<production-domain>/proxy` |

Webhook URIs in the same file are relative (`/api/shopify/webhooks/...`), so they follow `application_url`. Then run `npm run deploy` from `shopify-app/`. Deploying changes the live app for every installed store: do it only when the backend at that domain is up. Keep one app (do not create a second one); local work afterwards uses `shopify app dev`, which swaps in a tunnel URL while it runs.

## 2. Environment variables (state of the current `.env`, values never shown)
Check with `node -e` against `validateEnv` (src/config/env.js): the server refuses to start in production on any ERROR below and prints each WARNING.

| Variable | Needed for | Set today | If missing in production |
|---|---|---|---|
| `MONGODB_URI`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_TOKEN_ENCRYPTION_KEY` (32-byte base64) | the app | yes | ERROR: refuses to start |
| `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY`) | the AI | Gemini yes | ERROR if neither is set |
| `APP_URL` | OAuth, app proxy, webhooks | yes, **but it is the tunnel** | ERROR until it is the real https domain (tunnel and local addresses are rejected) |
| `SHOPIFY_OAUTH_REDIRECT_URI` | OAuth return | yes, **but it is the tunnel** | ERROR until it is an address on the same host as `APP_URL` |
| `ANTHROPIC_API_KEY` | second provider (Claude); optional | **no** | WARNING: `LLM_SECONDARY=claude` has no key, Gemini is the only provider |
| `METRICS_TOKEN` (24+ characters) | `/metrics` | **no** | WARNING: `/metrics` stays switched off (404) |
| `SENTRY_DSN` or `ALERT_WEBHOOK_URL` | being told about crashes | **no** | WARNING: nobody is told |
| `EMAIL_USER`, `EMAIL_APP_PASSWORD` | order codes and complaint mail | yes | WARNING: mail cannot be sent |
| `CLAMAV_HOST` | virus scan of uploads | **no** | WARNING: files are checked by content only |
| `OTP_HMAC_SECRET`, `ANALYTICS_HMAC_SECRET` | signing | yes | generated per deploy; keep them |

Result of running that check on the current `.env` as production: 2 errors (the two tunnel addresses above) and 4 warnings (Anthropic key, metrics token, Sentry/alert webhook, ClamAV). In development it passes with the one Anthropic warning.

## 3. Before the first deploy
1. **(you)** One Shopify app, one repository: backend at the root, widget and app config in `shopify-app/`.
2. **(you)** The production domain, then section 1.
3. **(you)** Secrets in the host's secret store (never in git): the variables of section 2.
4. **(you)** Gemini on a paid quota. On the free quota a normal run gets 429 and the shopper sees the connection-trouble line.
5. **(you)** Attachments: `ATTACHMENT_STORAGE=s3` (+ `S3_*`) and `CLAMAV_HOST`, or keep file upload off. Not verified against a real bucket.
6. **(you)** MongoDB: a managed cluster with backups and a tested restore. Not verified.
7. **(you)** Review scopes once in the Partner Dashboard. Each scope is tied to code in `src/config/shopifyScopes.js` and checked by `test/shopifyScopes.test.js`.

## 4. Running it
- One instance is verified. For several instances the support hub (`/support-ws`) needs sticky routing: sockets live in one process.
- Docker image: Node 22; CI runs Node 20 and 22. The full suite was run here on Node 24 only.
- Health: `GET /healthz`, `GET /readyz`. `/metrics` is 404 without `METRICS_TOKEN`, 401 with a wrong one.
- Providers: Gemini (model chain), then Claude when `ANTHROPIC_API_KEY` is set. Groq is not supported. A provider that fails, times out, is rate limited or answers with nothing hands the turn to the next one; a write tool already run in the turn is not run again.
- Rollback: redeploy the previous image. Schema changes are additive (`Complaint.mentions`, `lastMessageKey`, `choiceOfferedKey`, `asked`).

## 5. After the first deploy
- Install on a real dev store; check OAuth, the app proxy (`/apps/ai-agent/`), the webhooks (orders/create, orders/cancelled, refunds/create and the three privacy topics: run `shopify app deploy` so the new orders/cancelled subscription in the TOML is registered), one chat and one voice turn.
- Re-run the audit suite against the real model (`node audit/run.mjs`) and compare with `audit/reports/`.

## 6. Known limits at launch (stated, not hidden)
- **Currency (BUG-10).** Every amount the assistant says or shows is in the store's own Shopify currency. A visitor in another Shopify Market sees the page in their currency and the chat in the store's. Market prices are not used because they could not be verified (no valid store token here); amounts are never converted. `STORE_PRICES_FOLLOW_MARKET=1` exists but was not tested against a real market.
- **Monitoring is not active until you set it.** Without `SENTRY_DSN` or `ALERT_WEBHOOK_URL` nobody is told about a crash; without `METRICS_TOKEN`, `/metrics` is off.
- **Never verified on the real systems:** the real AI models (Gemini quota), voice and calls end to end, real e-mail delivery, a real order, the second store (Gada Electronics, not installed), load beyond 8 parallel shoppers.
- **The assistant states only what the backend confirmed:** an order, cancellation, refund, complaint, booking or e-mail is never reported as done unless a tool or action confirmed it (`src/agent/factGuard.js`, `test/doneClaims.test.js`). Checked with a scripted model only.
- **Dashboard screens:** Home, Conversations, Calls, Complaints, Bookings, Orders (with the privacy erase tool), Settings (alerts, privacy), Train, Insights, Widget. There is no separate Integrations, Notifications or Activity Log screen: notifications are the live "needs attention" counts, and the settings change history is under Train.

## 7. Manual real-store checkout test (not done: needs a dev store and its credentials)
Everything the tests cover was exercised with scripted Shopify answers only (test/shopifyOrderService.test.js, test/privacy.test.js, test/oneChatPerPerson.test.js, test/admin/orderDetails.test.js, widget e2e.mjs). Use a development store with the Bogus payment gateway, never a live store.

**Before you start (registers the new webhook).** The webhook subscriptions live in `shopify-app/shopify.app.ai-commerce-agent.toml` (orders/create, orders/cancelled, refunds/create, the three privacy topics). Set the production URLs in that file yourself, then from `shopify-app/` run `shopify app deploy` (this releases a new app version that registers the subscriptions on every store with the app installed). Check in the Dev Dashboard (Versions / Webhooks) that `orders/cancelled` is listed. `shopify app webhook trigger --topic orders/cancelled` can send a test delivery; the signature check will refuse it unless the secret matches the app's.

1. **Cart.** Ask for a product, pick a variant, quantity 2, add it; add a second product; change one quantity; remove one. The cart in the chat and Shopify's cart must agree (items, variants, quantities, total, currency).
2. **Stale price and stock.** Change that variant's price in Shopify admin, then order: the assistant must refuse and ask to refresh the cart. Set its stock to 0: it must refuse as unavailable. Unpublish or archive the product: same.
3. **Cash on delivery.** Give address and email, confirm. Shopify admin must show exactly ONE order tagged `Orbi-AI-Order` and `COD`, payment pending, unfulfilled, with the right items, discounts, shipping and tax. The chat card, the confirmation email and the dashboard Orders page (list and details) must show the same order number, items and total. The order must also carry the `ai_chat_ref` note attribute.
4. **Duplicate and retry.** Send the confirmation message again, and double-click the confirm button: still ONE order, the chat says it was already placed, no second email. Then, in a copy of the store or with the network throttled, interrupt a confirmation mid-request and ask again: the assistant must say the status is unconfirmed and check, never place a second order.
5. **Online payment.** The chat must show only a payment link and NO "order placed" card, and the dashboard must show no order yet. Pay with the Bogus gateway (card number 1, any future date). Within a minute the order must appear in the dashboard (orders/create webhook) with payment status paid; check the webhook delivery log in Shopify for a 200. Ask the chat for that order's status as the logged-in customer: payment paid, fulfilment unfulfilled, same total as the dashboard.
6. **Dead payment link.** Open a second payment link and do not pay; delete its draft order in Shopify admin; ask to pay again: a new link must be issued. Then pay a link, delete nothing, and ask again: the chat must report the real order, never a second link.
7. **Cancel and refund.** Refund part of the paid online order in Shopify admin (the refunds/create webhook, delivery log 200): the dashboard revenue and that customer's spend drop by exactly the refunded amount and the order still counts. Refund the rest: it stops counting as an order. Then cancel the COD order in Shopify admin (before fulfilment). The orders/cancelled webhook must arrive (delivery log 200); the dashboard revenue, order count, average order value and that customer's spend must drop by that order, and the Orders list must still show it as Cancelled. Fulfil another order with a tracking number: the dashboard details and the customer's order lookup must show the same tracking.
8. **Second store and ownership.** Repeat step 3 on a second installed store. Neither dashboard may show the other's orders; a customer logged in to store A must not be able to look up store B's order number, nor another customer's order number in store A.

**Revenue rules (the same everywhere: overview, orders count, customer spend, performance).** An order counts at its Shopify total in the store's currency, from the moment it is placed: paid and unpaid cash-on-delivery orders alike. A partial refund lowers it by the refunded amount Shopify reports. A cancelled order, a voided payment and a fully refunded order count as no order and no revenue. They stay in the Orders list with Shopify's own status. Refund and cancel state is always read back from Shopify (`order.totalRefundedSet`, `cancelledAt`, financial status), never worked out from anything else, and written as a state, so repeated or out-of-order webhooks end in the same place.

**Known limits (not fixed, by design or without a real store to test):**
- Refund figures and cancellations come from Shopify's API after a webhook. If Shopify's API is down for longer than the webhook retries (8 attempts, up to an hour apart), that order's refund is missing until its next webhook; the order details page still shows the live refunded amount.
- A chat that produced an order which was later cancelled keeps its "ordered" outcome label (the Conversations filter); only the order and revenue figures drop it.
- **Currency (BUG-10), exactly.** Every amount the assistant says, shows, totals and orders is in the store's own Shopify currency. When the storefront cart arrives in another currency (Shopify Markets) it is priced again from the store's own variant prices, and nothing is converted. If that price lookup fails, the cart stays whole in the visitor's currency (never a mixture), and the order is accepted only when Shopify's own price for the visitor's country matches every line; otherwise it is refused with a "refresh your cart" message. A fixed-amount discount is never applied to a cart in a different currency (the prepaid offer is not offered, and the order service refuses it); percentage discounts and discount codes are priced by Shopify. A visitor in another market therefore sees the page in their currency and the chat in the store's. Not tested against a real Markets store.
- After a timeout on a write, a repeat request first looks for the draft by its request tag. If Shopify shows it, the checkout continues from it; if Shopify does not show it (for example the search index is behind), the assistant reports the status as unconfirmed and creates nothing, until the same cart is checked in Shopify admin or changed. This is deliberate so no second draft or order can be created.
