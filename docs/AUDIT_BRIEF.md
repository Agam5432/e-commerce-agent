# Audit brief: Orbi AI (for the model doing the full bug audit)

Read this first. It tells you what the project is, what was already read and tested, what was NOT, and the rules for the audit.
The owner writes in Hinglish; reply to them in the same simple Hinglish, keep code and file names as they are.

## 0. Rules (follow these)

1. **Do not change code until the owner approves a finding.** First report, then fix what they approve.
2. **A bug counts only when proven**: a failing test, a reproduced run, or a quoted line of code with the exact failing input. Otherwise label it `SUSPECTED`.
3. In every report, mark each statement `VERIFIED` (you read the code or ran it) or `ASSUMED`. Never mix them.
4. Read whole files, not only `grep` hits. For each file you finish, say so, so the owner can see coverage.
5. **Secrets:** `D:\mini-agent\.env` holds real keys (Shopify secret, Gemini, SMTP). Never print, log, copy or paste its values. Do not ask the owner to paste passwords or the TURN credential in chat.
6. Test with real data where possible (dev store `techstore-3qkasoly.myshopify.com`, real orders are allowed there, it is a dev store). Never point tests at the owner's real MongoDB data: use the throwaway `mongod` (`test/helpers/tempMongo.js`) and a separate port.
7. Multi-tenant isolation (`shop` in every query, shop only from a verified credential) is the most important property. Treat any break as critical.
8. Do not add features. This is an audit. Small safe fixes only after approval.

## 1. What the project is

A Shopify AI shopping assistant (multi-tenant SaaS).
- `D:\mini-agent`: Node 24 / Express / MongoDB (Mongoose) backend + embedded Shopify admin dashboard (vanilla JS modules + Tailwind built CSS, `npm run build:admin`).
- `D:\shopify-widget\ai-commerce-agent`: Shopify theme app extension (the storefront chat widget, vanilla JS) and its browser tests (`tests/widget`).
- Agent: LangGraph tool-calling, Gemini primary, Claude secondary (`ANTHROPIC_API_KEY` is NOT set, so no fallback today). Voice: Gemini Live over WebSocket.
- Live human calls: WebRTC audio, signalling over `/support-ws`, TURN optional (the owner is setting up a free Metered TURN; the credential goes only in `.env`).
- Industries: only `ecommerce` exists; registry in `src/industries/index.js`.

Run: `npm start` (port from `.env`, usually 3000; an older server may already be running there). Tests: `npm test` (`node --test`, about 1042 tests, needs a `mongod` binary, takes several minutes, run it in the background). Lint: `npm run lint`. Use another port (for example 3012) and a temp Mongo for any server you start yourself.

## 2. Map of `D:\mini-agent`

`src/`
- `routes/`: shopper-facing APIs (`shopifyProxyRoutes.js` App Proxy signed, `supportProxyRoutes.js`, OAuth, webhooks).
- `admin/`: owner dashboard API (`auth.js` session-token check, `routes.js`, `stats.js`, `supportRoutes.js`, `complaintRoutes.js`, `callAnalytics.js`, `consoleAuth.js` call-window token, `settings.js`).
- `services/`: business logic (`supportService.js`, `supportHub.js`, `bookingService.js`, `complaintService.js`, `conversationLog.js`, `people.js`, `visitorMemory.js`, `emailService.js`, `objectStorage.js`, Shopify services, `voiceSessionLog.js`).
- `agent/`: `agent.js` (about 1300 lines), `core/`, guards (`factGuard`, `availabilityGuard`, `sameKindGuard`, `requestGuards`, `untrusted`, `modelHealth`, `cardSelection`).
- `industries/ecommerce.js` + `ecommerce/` (system prompt, tool definitions, handlers: cart, catalog, checkout, orders, complaints, offers, billing).
- `tools/shopify/` (search, products, cart, catalog, caches, policies, offers).
- `voice/` (transcript utils, governor, live transcription), `models/` (20 Mongoose schemas), `http/` (hardening, storefront CORS), `observability/`, `config/`, `public/admin/` (dashboard frontend, call window, ringtones).
- `server.js` (about 780 lines): app wiring, voice WebSocket, webhooks.
- `test/` (120 files), `scripts/` (one-off tools; `backfill-support-calls.mjs` is dry-run by default).

## 3. Already read and changed carefully (VERIFIED by the previous model)

Calls, support, bookings, complaints, Customer 360, auth for the dashboard:
`supportService.js`, `supportHub.js` (mostly), `SupportCall.js`, `consoleAuth.js`, `admin/auth.js`, `supportRoutes.js`, `bookingService.js`, `complaintService.js`, `people.js`, `visitorMemory.js`, `admin/stats.js` (customer parts), `admin/callAnalytics.js`, `voiceSessionLog.js`, the dashboard Calls/Customers screens, and their tests. The widget consent, callback and echo-guard parts were also changed in an earlier session. All of this passes `npm test` (1042) and lint, and was checked once in a real Chromium against a temp Mongo.

## 4. NOT read in full (the audit must cover these)

Priority order:
1. **Security surface:** `routes/shopifyOAuthRoutes.js`, `routes/shopifyWebhookRoutes.js` (HMAC, replay), `services/shopifyTokenService.js`, `utils/tokenEncryption.js` (key rotation), `services/objectStorage.js`, `malwareScan.js`, `attachmentService.js`, `http/hardening.js`, `http/storefrontCors.js`, `server.js` (all of it), `services/voiceTokenService.js`, `tokenReplay`, `admin/settings.js`, `dataPrivacy.js`.
2. **Agent core:** `agent/agent.js`, `agent/core/*`, `industries/ecommerce.js` (about 1850 lines), `systemPrompt.js`, guards, `tools/shopify/*`, `shopifyOrderService.js`, `cartPricing.js`, checkout services.
3. **Files with no test coverage** (run a coverage report to find them: `node --test --experimental-test-coverage`).
4. **Voice:** Gemini Live session handling in `server.js` and `src/voice/*`.
5. **Dashboard screens not yet read:** Home, Conversations, Settings, Train, Widget, Insights; and the widget's `ai-chat-widget.js` (large).

## 5. Known issues and gaps (already found, do not rediscover)

- The call-window console token (`CONSOLE_ALLOWED` in `consoleAuth.js`) can read ANY conversation of the shop by id (`GET /conversations/:id`), list all calls with customer contact (`GET /support/calls`) and see the whole team (`/support/state`). Fine for the owner's own window, NOT for a future staff portal.
- `personKeyFor` makes an `e<hash>` key from an unverified typed email; the dashboard groups different browsers using the same typed email as one guest. Labelled "Guest (email not verified)", not merged for any customer-facing use. Cookie loss for anonymous visitors is not recoverable (by design, no OTP yet).
- Call transfer between employees is not built (`transfers` stays empty). Staff Support Portal, OTP identity recovery, smart routing, waiting queue, multi-industry: planned only.
- Presence name for a call window is typed by the user; the identity is the Shopify user id.
- The hub keeps sockets in one process (multi-instance needs sticky routing).
- Hard-coded word lists remain in some agent heuristics (for example gender words); thresholds are in code, not `.env`.
- Gemini 503/429 with only one provider configured is a production risk.
- `ANTHROPIC_API_KEY`, `CLAMAV_HOST`, `METRICS_TOKEN`, `SENTRY_DSN`, S3 storage and a real `APP_URL` are not set in the dev `.env`.
- Windows Firewall rule `codex_sandbox_offline_block_inbound` on the owner's laptop blocks inbound traffic and broke direct WebRTC; TURN is the permanent fix.
- Git: many changes are uncommitted on branch `master` (main branch is `main`). Do not commit or push without being asked.

## 6. Environment notes

- Windows 11, Git Bash + PowerShell. Use the dedicated tools; avoid heredocs with backslashes or `${}` (they got mangled before: write files with the Write tool).
- **Disk:** drive `C:` was nearly full and temp `mongod` data folders (`%TEMP%\orbi-mongo-*`) leaked and broke tests (`OutOfDiskSpace`, mongod needs 500 MB free). Check free space before a test run and delete leaked `orbi-mongo-*` folders only when no `mongod` uses them.
- Long commands time out at 120 s: run `npm test` in the background and wait with a Monitor.
- Playwright: Chromium is at `%LOCALAPPDATA%\ms-playwright\chromium-1228\chrome-win64\chrome.exe` (use `executablePath`; widget harness honours `PW_CHROMIUM` and `PYTHON`).
- Dashboard in a browser: serve the app on a spare port, intercept `https://cdn.shopify.com/**` to define `window.shopify.idToken`, and mint an HS256 session token with the app secret (see how earlier tests did it).
- Signed App Proxy requests (HMAC-SHA256 over sorted params) are needed to call `/proxy/*` locally.

## 7. How to run the audit

1. Run `npm run lint`, `npm audit`, a secret scan, and the coverage report. List files without coverage.
2. Work in the priority order of section 4. For each file: read it fully, write down what it does, then look for: missing `shop` filter, trusting client input, auth or replay gaps, injection (NoSQL, prompt, HTML), unbounded loops or memory, missing timeouts, error paths that report success, races (check-then-write without an atomic condition), PII in logs, unhandled promise rejections.
3. For each suspected bug, try to prove it with a test or a reproduced request. Put proven bugs in the report as `CONFIRMED` with the failing input; others as `SUSPECTED`.
4. Report format per finding: severity (critical/high/medium/low), file and line, what breaks, exact reproduction, proposed fix (do not apply yet), and `VERIFIED/ASSUMED`.
5. End with: files fully read, files skipped and why, what could only be tested by the owner (real microphone echo, two real networks, real Google Calendar, real TURN), and the top 5 things to fix first.
6. After the owner approves a fix, apply it with a regression test, run `npm run lint` and the relevant tests, and then the full `npm test` before reporting done.
