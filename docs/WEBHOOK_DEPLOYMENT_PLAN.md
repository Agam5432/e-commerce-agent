# Webhook investigation log and deployment plan (nothing has been deployed)

## ROOT CAUSE FOUND (2026-11-17, real Shopify events). This supersedes the "Correction" and "Recommendation" sections below.
Evidence (ngrok request inspector on the tunnel + `WebhookReceipt` + Shopify Admin):
- The active version 39 declares all four subscriptions (checked with `shopify app config pull`; the local TOML was restored byte for byte afterwards). `orders/create` IS delivered by Shopify for every order (#1028 to #1037), each 200, receipt `done` in under 1 s.
- For the cancellations and refunds of #1029, #1030, #1031 and a partial refund of #1032, Shopify sent NOTHING to the tunnel (no request at all, not even a rejected one), while the same backend route answers a signed sample with 200. So it was never a backend, HMAC or tunnel problem: the TOML-declared `orders/cancelled` and `refunds/create` subscriptions are not active on TechStore. (The 2026-11-16 06:12Z receipts were Shopify retries for #1026 after the route first existed.)
- Workaround through the app's own supported Admin API, no deploy or release: `scripts/register-order-webhooks.mjs` registered ORDERS_CANCELLED and REFUNDS_CREATE for the tunnel URL (subscription ids 2109566615588 and 2109566648356). From then on every real cancel and refund arrived (200) within about 1 s and was processed: the tunnel saw `orders/cancelled 200 x2` and `refunds/create 200 x3` for #1033, #1032, #1035, #1036, #1037 (more receipts exist; see PROGRESS.md).
- Caveat: if a later `shopify app deploy` makes the TOML subscriptions active as well, each event arrives twice. The handlers are idempotent (refund totals are read back from Shopify, the cancel update is guarded by `$exists`, receipts de-duplicate by webhook id). Then remove the API copies with `node scripts/register-order-webhooks.mjs <shop> --delete`.
- A deploy is therefore NOT needed for the order webhooks on TechStore. Whether a deploy would activate the TOML ones is unknown; it was not tried (not authorised). The Dev Dashboard delivery logs could not be read (the debug Chrome is not signed in to Shopify; no credentials were entered).
- Not yet exercised with real Shopify events: the compliance topics and APP_UNINSTALLED (unit tests only).

---

# Earlier plan (kept for reference)

## Correction to the previous report (important)
The earlier statement "the store has only APP_UNINSTALLED, orders webhooks are not registered, deploy needed" was WRONG. Two mistakes: (1) `webhookSubscriptions` in the Admin API does not list subscriptions declared in the app TOML, only the API-created APP_UNINSTALLED; (2) my first database check filtered on a field that does not exist (`createdAt`; the model uses `receivedAt`).
Real evidence (collection `WebhookReceipt`, 7 rows, all status `done`):
- `orders/create` delivered and processed for #1028 (2026-11-16 22:31:49Z), #1029 (22:47:07Z) and #1030 (2026-11-17 04:07:33Z).
- `orders/cancelled` and `refunds/create` were delivered once on 2026-11-16 06:12Z (before this test round).
- `orders/cancelled` for #1029 (cancelled 04:02:19Z), `orders/cancelled` and `refunds/create` for #1030 (04:08Z) were NOT received (checked at 06:59Z, ~3 h later). Shopify retries for up to 48 h; so far nothing. Cause UNDETERMINED (candidates: the delivery failed on the tunnel/server side at that moment and Shopify is still retrying; or Shopify did not fire the topics for an `orderCancel` API job). The Dev Dashboard webhook delivery log would show it; I cannot read that log from here.
- The active app version is `ai-commerce-agent-39` ("Add ord...", created 2026-11-16 06:46Z), i.e. the order webhooks were already released once. The app's installed scopes equal the TOML scopes (11 each).
So a deploy is probably NOT needed to receive orders/create, and may not be needed for the other two either. First find out why the 04:02-04:08 events did not arrive (below, step A). Deploy only if the delivery log shows the subscription is missing.

## 1. Which app configuration changes would be deployed
`shopify app deploy --config ai-commerce-agent` from `shopify-app/` releases the WHOLE current working copy as a new version, not just webhooks:
- `shopify.app.ai-commerce-agent.toml`: webhooks (orders/create, orders/cancelled, refunds/create, 3 compliance topics), scopes (unchanged), `application_url`, `[auth] redirect_urls`, `[app_proxy]` url/prefix/subpath. All URLs in the file are currently the ngrok tunnel `https://violin-mayflower-sandstorm.ngrok-free.dev`.
- The theme extension `extensions/ai-chat-widget` (assets `ai-chat-widget.js/.css`, support js/css, block `ai_chat_widget.liquid`): the local copy contains all widget fixes made since version 39 (the widget the shoppers get).
There is no config-only deploy command in this CLI flow. Narrower alternatives: `shopify app deploy --no-release` (creates a version, releases nothing) followed by an explicit `shopify app release --version <name>` after review.

## 2. Webhook subscriptions that would be registered
orders/create -> /api/shopify/webhooks/orders-create; orders/cancelled -> .../orders-cancelled; refunds/create -> .../refunds-create; compliance topics customers/data_request, customers/redact, shop/redact -> .../compliance. (APP_UNINSTALLED is registered by the app itself through the API, not by the TOML.) These are already declared in version 39 per its message; I cannot read the version's contents from the CLI list, only its name/status.

## 3. New app version?
Yes. A deploy creates `ai-commerce-agent-40` and (without `--no-release`) makes it the active version immediately.

## 4. Effect on the installed TechStore app and widget
Yes, immediately: the active version is what TechStore runs. The theme extension change reaches TechStore shoppers' storefront as soon as it is released (no re-install). Scopes are unchanged, so no re-consent. If `application_url`/proxy URL in the TOML differ from what the app uses today, the storefront proxy (`/apps/ai-agent/...`, the chat) would point at the new URL.

## 5. Production code, customer data, configuration, existing versions
- Customer data: none touched. Production backend code: not touched by the deploy (it only uploads config and the theme extension); the backend keeps running from this machine/tunnel.
- Configuration: the app's Shopify-side config changes (webhook list, URLs, proxy) and the live widget code change. Version 39 stays in the version list as inactive and can be re-activated.
- RISK: because every URL in the TOML is the ngrok dev tunnel, deploying it makes a RELEASED version point at a tunnel. The production checklist says to set production URLs first; I have not.

## 6. How webhook delivery would be verified
A. (No deploy, can be done now) Read the delivery log in the Dev Dashboard (Versions / Webhooks) for the 04:02-04:08Z events; test the endpoint with `shopify app webhook trigger --topic orders/cancelled --address <tunnel>/api/shopify/webhooks/orders-cancelled` (sample payload, signed with the app secret; no store data touched); create ONE new COD test order and cancel it through the chat tool, then check `WebhookReceipt` for orders/create + orders/cancelled and the Event's `props.cancelledAt`; refund one Bogus-paid test order and check `refunds/create`.
B. After a deploy (if ever): same checks, plus `shopify app versions list` shows v40 active, and every receipt reaches `status: done` with `lastError` empty; a bad signature must return 401 (already unit-tested).

## 7. Rollback
Re-activate the previous version: `shopify app release --version ai-commerce-agent-39 --config ai-commerce-agent` (it takes effect for TechStore immediately). Nothing in the database needs reverting (receipts expire after a week; events are idempotent: the same webhook twice changes nothing). The one-off Event update I made for #1029 is also what the webhook would set.

## Recommendation
Do not deploy yet. Step A first: it is read-only/test-only and may show that no deploy is needed. If a deploy is still wanted later: (1) set the production URLs, (2) `shopify app deploy --no-release`, (3) review, (4) release, (5) verify as in 6B. This needs the owner's explicit approval.
