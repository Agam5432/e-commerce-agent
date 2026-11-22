# Security audit

Scope: the shopper-facing app-proxy API, the dashboard API, webhooks, WebSockets, order and complaint tools, prompt handling, multi-store isolation and the code. 100+ sandbox cases ran against an isolated backend (throwaway MongoDB, every Shopify write refused and recorded, e-mail off, planted fake customers and canary strings). No cross-customer, cross-store or secret leak was observed in any case that ran. Items that need the real model after the fixes, real e-mail, voice, real checkout or a second real store were NOT tested.

## Result by area

| Area | Result | Evidence (test ids) |
| --- | --- | --- |
| Authentication of shopper requests (signature, timestamp, unknown or uninstalled store) | PASS | M01-M05 |
| Dashboard API without or with a forged session token; webhooks without or with a forged HMAC | PASS | M13-M16 |
| WebSocket handshakes (voice, support) without a valid token | PASS | M23-M25 |
| CORS for storefront APIs (evil origin refused, connected store allowed, uninstalled store refused) | PASS | M17-M19; S10 for the OAuth routes (LOW) |
| Order privacy: another customer's order, address, email, phone; spoofed login in the request body | PASS (no leak); the guest one-time-code flow worked end to end and a wrong code invalidated the code | G01-G09, J01-J12, E10-E11 |
| Order cancellation safety: three-stage confirmation enforced by the server, ownership re-checked, a refused write is reported honestly | PASS | E13, E14, J04, J05 |
| Prompt injection: direct, from product text, from the store policy, encoded, role-play | PASS (no secret, prompt text or injected code reached the reply; no Shopify write attempted) | H01-H16 |
| Multi-store isolation (catalogs, conversations, orders with the same number, dashboard tokens, one store's outage) | PASS in the sandbox (a second store was simulated: it is not installed in production) | N01-N10 |
| Discounts and price manipulation | PASS for codes and the 1-dollar request; BUG-03 for browser-supplied cart prices (quote only) | I01-I08 |
| Errors and outages (Shopify 500/slow, provider failure, MongoDB down) without internal text | PASS | O01-O03, O09 |
| Static review (secrets, hardcoded stores, tenant from client input, NoSQL operators, eval, logs, error text, rate limits, dependencies) | 13 PASS, 4 LOW findings | S01-S17 |
| Real-store read-only checks | Prices match live Shopify; the recorded catalog used by older tests was stale | L01-L05, real storefront run |

## Security findings

- **BUG-12 [LOW] OAuth routes reflect any origin with credentials**: Not exploitable today because the routes use bearer session tokens, never cookies. Fix: FIXED: credentials: false on the OAuth CORS policy (the routes use bearer tokens; the state cookie is read only on top-level navigations). Test: test/hardening.test.js (BUG-12). The origin is still reflected, which is harmless without credentials.

## Static scan (S01-S17)

| ID | Check | Status | Note |
| --- | --- | --- | --- |
| S01 | Hardcoded API keys / tokens / DB credentials in tracked files | PASS | no secret pattern in code, docs, configs or the widget |
| S02 | .env or its backups tracked by git | PASS | .env is git-ignored and not tracked (the real file was not read for this check beyond key names) |
| S03 | Hardcoded store domains in backend code | PASS | no literal store domain used for logic (only validation patterns) |
| S04 | Hardcoded external URLs / origins in backend code | PASS | reviewed every hit: only Shopify's own fixed domains (admin.shopify.com in the CSP frame-ancestors and dashboard links, the shop's own /admin/oauth and /admin/api endpoints) and a validation message; no customer-specific or environment-specific literal |
| S05 | Tenant (shop) taken from client input outside OAuth/entry | PASS | the shop is only taken from the signed proxy, session token or HMAC-verified webhook (OAuth/entry are the only client-supplied shop reads, both verified) |
| S06 | Request values placed directly in MongoDB filters (operator injection) | PASS | no direct req.* in a filter on one line (multi-line cases need review; chat inputs were also tested with {$ne} objects in M07/M08) |
| S07 | Dynamic code execution / shell use in backend | PASS | none in backend code |
| S08 | Personal data or secrets possibly written to logs | PASS | reviewed every hit: logs carry fixed text, status codes, store domains or redacted addresses; the token-refresh logs print domain/status/error name only, never a token |
| S09 | Raw exception text returned to the client | PASS | reviewed: the only hit returns SettingsConflictError's own fixed message (409), not an exception text |
| S10 | CORS that reflects any origin | FAIL | OAuth routes use cors({ origin: true, credentials: true }) (src/routes/shopifyOAuthRoutes.js:19-21): any origin is reflected WITH credentials. Not exploitable today because every route authenticates by a bearer session token, never a cookie; still an anti-pattern. The dashboard router (origin: true, credentials: false) is by design. |
| S11 | Shopper-facing routes without a rate limiter on the route line | PASS | reviewed: GET /proxy/ only returns the static backend address; POST /api/uploads is authorised by a one-time upload token (consumed on use) issued by a rate-limited route |
| S12 | Duplicated Shopify GraphQL clients (different timeouts and error handling) | FAIL | 3 separate implementations: a fix in one is missed in the others |
| S13 | Shopify API version defined in several places | FAIL | 5 definitions of the Admin API version |
| S14 | Widget stores customer details in localStorage | FAIL | customer details are kept on the device for up to 24 h (cleared when the page shows no login signal since the earlier fix) |
| S15 | Voice WebSocket handshake is authenticated before audio | PASS | verifyClient checks a one-time token in the subprotocol (also exercised by M23/M24) |
| S16 | Dependency vulnerabilities (npm audit, production) | PASS | npm audit: 0 vulnerabilities |
| S17 | Widget writes unescaped values with innerHTML | PASS | reviewed: the only hit restores the send button's own previously captured HTML |

## Recommendations

1. Re-price the cart from Shopify before quoting any total (BUG-03).
1. Restrict the OAuth CORS origins (BUG-12) and merge the three GraphQL clients (BUG-11).
1. Set METRICS_TOKEN and SENTRY_DSN or ALERT_WEBHOOK_URL, and put the production domain in APP_URL, SHOPIFY_OAUTH_REDIRECT_URI and the three TOML URLs.
1. Test real e-mail delivery, voice and a real checkout on a dev store with a throwaway cart, then re-run the audit against the real model.
