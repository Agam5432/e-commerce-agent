# Production readiness

## Verdict: NOT READY for general production; limited pilot possible after the configuration items

No customer-data leak, cross-store leak, authorization bypass or credential exposure was found in any test that ran, and the order-cancellation and consent gates are enforced by the server. The defects that were found in customer-facing behaviour (wrong currency sign, empty greeting, budget, cards, complaint flow, empty-provider fallback, duplicate tool execution) now have fixes verified by unit, agent-level or browser tests. They have NOT been re-verified on the real model because its quota is exhausted, and several important areas were never tested (voice, real checkout, real e-mail, load, a second real store).

## Blocking issues

- The fixes for browse cards, complaint wording and off-topic handling are not verified on the real model.
- Gemini quota: on the free quota customers get the connection-trouble line; ANTHROPIC_API_KEY is not set, so there is no second provider.
- Production domain: the three TOML URLs, APP_URL and SHOPIFY_OAUTH_REDIRECT_URI still point at the ngrok tunnel; startup in production refuses that.
- METRICS_TOKEN and SENTRY_DSN (or ALERT_WEBHOOK_URL) are not set: nobody would be told about failures.

## High-priority fixes

- BUG-01 [HIGH] Prices shown with the wrong currency sign (a USD store's $429 written as ₹429) (FIXED)
- BUG-06 [HIGH] Complaint workflow: the same question asked four times, no complaint offered, a person called without consent (FIXED in the backend)
- BUG-07 [HIGH] An empty answer from Gemini was shown as 'connection trouble' without trying Claude (FIXED)
- BUG-08 [HIGH] A provider failing after a write tool could make the next provider run the tool again (FIXED)

## Remaining risks

- BUG-03 (browser cart prices quoted), BUG-10 (page versus chat currency), BUG-11/12 (code quality).
- Model answers vary run to run; one green run is not a guarantee.
- Single-instance support hub (sticky routing needed for more than one instance); Node 22 image not run through the full suite here.

## What was NOT tested

- **Real model after the fixes:** Gemini quota was exhausted during the fix phase. Every claim about the model's behaviour after the fixes (browse cards, complaint wording, off-topic redirect, budget wording) is supported by unit/agent tests with a scripted model only.
- **Real model before the fixes:** The sandbox run (166 cases) and the real storefront run (22 steps) are real-model results, but the model's answers vary between runs (A09, B02, D05 changed between runs).
- **Voice:** Needs a live microphone and Gemini Live. NOT TESTED.
- **Real checkout and order placement:** Code paths now covered with scripted Shopify answers only (draft order, payment link, replay after payment, deleted draft, cancel webhook, throttling); the manual real-store test is in docs/PRODUCTION_CHECKLIST.md section 7. Would create a draft order or order in a store with real customers (25 orders, 6 customers). NOT TESTED.
- **Real e-mail delivery:** E-mail was switched off in the sandbox on purpose; complaint and one-time-code mail were not sent. NOT TESTED.
- **Second real store:** Gada Electronics is not installed in the production database; isolation was tested with a simulated second store.
- **Load:** Only 8 parallel shoppers and a 60-request rate-limit burst were run.
- **Production domain, ANTHROPIC_API_KEY, METRICS_TOKEN, SENTRY_DSN:** Not provided. Configuration-dependent.

## Final release recommendation

Do not release to all merchants yet. After the four blockers are closed and the audit is re-run on the real model, a supervised pilot on one store is reasonable; full release should wait for a real checkout, e-mail and voice test.
