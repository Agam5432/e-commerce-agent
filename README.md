# mini-agent – Orbi AI backend

Node/Express service behind the Shopify storefront widget and merchant dashboard.

* AI agent (LangGraph) with Claude → Gemini → Groq fallback; every customer reply is written by the AI from live store data.
* Voice over WebSocket (Gemini Live transcription, barge-in handled in the widget).
* MongoDB for checkout sessions, conversations, attachments and analytics. Every query is scoped by `shop`.

## Endpoints

| Path | Who | Purpose |
| --- | --- | --- |
| `/proxy/greeting`, `/proxy/chat`, `/proxy/suggestions`, `/proxy/voice-token`, `/proxy/reset-chat` | Storefront via the signed Shopify app proxy | Chat, AI-written opening message and suggestion chips, voice token, clear chat |
| `/api/uploads` | Storefront, `Authorization: Bearer <upload token>` (one-time, from `/proxy/voice-token` with `purpose: "upload"`) | Up to 10 photos / videos / PDFs per message: checked by content, virus-scanned when `CLAMAV_HOST` is set, within the store's quota, stored in MongoDB or S3-compatible storage |
| `wss://…/` | Storefront, token in the subprotocol (`orbi.voice.v1`, `orbi.token.<token>`) | Voice call; the one-time voice token is checked during the handshake |
| `/` (entry URL) | Shopify admin (iframe) | The merchant dashboard page (`src/admin/shell.html` + `src/public/admin/`), after the install / token-exchange check |
| `/admin/api/*` | Merchant dashboard, Shopify session token | Overview, chats, attachments, orders, customers, settings |
| `/api/shopify/*` | Shopify | OAuth and webhooks |
| `/healthz`, `/readyz` | Platform | Probes |
| `/metrics` | Prometheus, `Authorization: Bearer <METRICS_TOKEN>` | Requests, AI calls (tokens, time, cost), rate limits, voice, uploads, errors, memory, event-loop delay. 404 without `METRICS_TOKEN` |

## Merchant dashboard

The dashboard is a small web app served by this backend and shown inside Shopify admin as an embedded (iframe) app. Plain ES modules, no framework: the screens are in `src/public/admin/screens/`, the logic that does not touch the screen is in `src/public/admin/lib/` (tested with `node --test`, see `test/admin-ui/`), and the page is `src/admin/shell.html`. The styles are Tailwind built from `admin-ui/input.css` and `tailwind.config.cjs` into `src/public/admin/app.css` (committed, so the Docker image needs no build step): after changing a class in a screen or the design tokens, run `npm run build:admin`. It signs every call with the Shopify session token from App Bridge. Screens: **Home**, **Conversations** (read, take over, hand back, resolve, notes, refund or exchange requests), **Orders & Customers** (with Shopify's payment and delivery status, and erasing a person's data), **Bookings**, **Catalog insights** (what shoppers asked for that the store could not give, most shown, most added to the cart), **AI quality**, **Train your assistant**, **Widget** (switching on the storefront chat bubble) and **Settings**. Everything shown is counted from what was recorded for the store; the numbers come from `/admin/api/*` (`src/admin/`). The old `extensions/app-home` UI extension must be removed from the Shopify app, otherwise it takes over the app's home page.

## Customer care (a person joins a chat)

The AI asks for a person with `flag_for_owner` (the chat shows "Needs follow-up" with the reason, and the owner is emailed once). From the chat page in the dashboard the team can then reply to the shopper:

- **Take over / send a reply**: sets `Conversation.handoff.active`. While it is set, `POST /proxy/chat` records the shopper's message for the team and returns `{ answer: "", handedOff: true }`: the AI is not called and nothing is written on the shopper's behalf.
- **Team replies** are `Message` rows with `role: "staff"`, kept at least 3 days so they can be delivered even when transcripts are off. The storefront widget fetches them with `POST /proxy/staff-messages` (rate limited; it only asks while a chat is flagged or taken over, and stops when the response says `watch: false`).
- **Hand back to the AI** or **Mark resolved** clears `handoff`. After the usual 30 minutes of silence the shopper is in a new chat and the AI answers again.
- Admin API: `POST /admin/api/conversations/:id/reply` `{ text }`, `POST /admin/api/conversations/:id/handoff` `{ active }`. Logic is in `src/services/handoff.js`; the browser test is `tests/widget/team.mjs` in the Shopify app.

### Refund / exchange status
On a chat page the owner records the request (refund, exchange, return, replacement) with a status (received, in progress, approved, completed, rejected) and a note for the customer. It is stored on the conversation (`case`), and the agent reads it before answering "where is my refund?". The agent only repeats what the team wrote; with no update it says so.

### What the agent remembers about a visitor
The widget keeps a first-party cookie (`ai_commerce_client_id`, 30 days, renewed on every visit). Everything the agent knows is looked up by that id (`src/services/visitorMemory.js`): details the visitor gave, their orders, earlier chats, open requests. The agent checks this before asking anything. Email-OTP verification is remembered for the same id, so a verified guest is not asked again for each order. Clear the cookie and the visitor is new: the agent starts fresh, while the store keeps its own copy for the owner.

### Files during a voice call
The call strip has an attach button. Files are uploaded as usual, then the call gets `{type: "attachments", ids}`; the agent describes and answers them like a typed attachment (`src/voice/voiceFiles.js`).

## Live help from a person (audio call in the chat)

A shopper who asks for a person can talk to a team member by audio, from the chat window, without installing anything. The team member takes the call in the dashboard, in the browser. It is **audio only** (no camera is ever asked for), browser to browser over WebRTC; the audio never passes through this server. Callbacks reuse the existing call booking (`services/bookingService.js`): there is no second booking system.

**Switching it on.** Dashboard, Settings, "Live help from a person": `liveEnabled` (off by default), `audioEnabled`, `recordingEnabled` (off by default). A store that never opens this setting behaves exactly as before. A team member is available only while they are set to **Online** (top right of the dashboard) and their browser keeps reporting in.

**The shopper's side** (`ai-chat-widget-support.js` in the widget, next to `ai-chat-widget.js`):
1. The AI calls the `request_human_support` tool when the shopper clearly asks for a person (the tool exists only when audio help is on). The backend decides what is possible; the AI never says a person has joined.
2. The window asks whether to save the call (only when the owner allows recording). Saying no changes nothing about the help.
3. The microphone is asked for (audio only). Then `POST /proxy/support/request`: when nobody is free nothing is created and the shopper is told so politely, with "Try connecting again" and, when the owner offers callbacks, "Schedule a callback" (a day and time picker over the store's real free slots; the time is re-checked and reserved atomically, then the calendar event follows).
4. While waiting the connecting screen is shown; "Connected" appears only when the server and the audio both say so. The chat stays usable during the call (the AI is silent while a person has the call; what the shopper types goes to the team).
5. When the call ends the chat goes back to the AI and the chat gets a line: `Audio call with <name> · Duration 06:24 · Completed`, with a play button when a recording was saved.

**Where calls are taken.** Shopify's admin adds no microphone permission to an embedded app, so a team member's calls are taken in a small separate window (`/admin/console.html`), opened by the "Take calls" button in the dashboard. The dashboard hands the window a one-time key (`POST /admin/api/support/console-ticket`, two minutes, usable once; read from the address and removed at once); the window swaps it for a session (`POST /support-console/session`, `SUPPORT_CONSOLE_HOURS`) bound to the same store and person that can only take calls and talk in their chat (it cannot read orders or change settings). Where the page is allowed the microphone (outside Shopify's frame) the dashboard takes calls itself.

**The team's side** (`src/public/admin/support.js`): presence control in the top bar, an incoming-call card (customer, reason, whether a recording was agreed), Accept / Reject, the active-call panel (timer, waveform, mute, end, recording status, the chat beside the call with a reply box), call history and a recording player on the conversation, "Human requested / Waiting for human / Human connected / Callback scheduled" tabs on Conversations, and live numbers on Home (online, busy, active calls, waiting, pending requests, callbacks).

**Data** (MongoDB, every document carries `shop`): `SupportCall` (request and call; one open request per chat through a unique sparse `openKey`), `SupportPresence` (heartbeat; busy is derived from `activeCallId`), `SupportRecording` (private audio), `Conversation.support` / `Conversation.handoff.callId`, `Message.call`, and the `support` section of `AgentSettings`. Accepting is atomic twice (the person must be free; the call must still be waiting), so two team members can never take the same call.

**Endpoints.** Shopper, through the Shopify App Proxy (shop from the verified signature): `POST /proxy/support/status | request | token | cancel | slots | callback | recording`. Team, through the Shopify session token (shop from the token): `GET /admin/api/support/state`, `POST /admin/api/support/presence`, `GET /admin/api/support/calls`, `POST|GET /admin/api/support/calls/:id/recording` (and `/recording-failed`). The call's text messages use the existing `/admin/api/conversations/:id/reply`.

**WebSocket `/support-ws`** (subprotocol `orbi.support.v1` plus `orbi.token.<one-time call token>` for a shopper, or `orbi.admin.<Shopify session token>` for the team; the voice socket on `/` is untouched). JSON messages:
- team to server: `heartbeat`, `presence {status, name}`, `auth {token}` (every 8 minutes; the session token lives one), `accept {callId}`, `reject {callId}`, `signal {callId, kind: offer|answer|candidate, data}`, `connected {callId}`, `hangup {callId, reason?}`, `recording {callId, state: "failed", error}`.
- shopper to server: `signal`, `connected`, `hangup`, `withdraw_recording {callId}`.
- server to team: `ready {representative, team, waiting, active, ice, turn}`, `presence {team}`, `incoming {call}`, `incoming_gone {callId, reason}`, `accepted {call, ice}`, `signal`, `connected {call}`, `ended {call}`, `recording_withdrawn {callId}`, `error {code, message}`.
- server to shopper: `ready {call, ice}`, `accepted {call, representative}`, `signal`, `connected {call}`, `ended {call}`, `recording_withdrawn`, `error`.

**WebRTC flow.** The shopper's browser asks for the microphone first, then the request is made. When a team member accepts, the server tells the shopper's browser, which creates the offer; the team member's browser answers; ICE candidates are relayed both ways; each side reports `connected` when its peer connection is up, and only then does the server mark the call connected. Whoever hangs up (or whose connection is lost for good) ends it for both; the server also ends a call whose team member stopped reporting in, and one whose shopper did not come back within `SUPPORT_CUSTOMER_GRACE_SECONDS`.

**Recording.** Optional on both sides: the owner must allow it and the shopper must agree before the call. The team member's browser mixes both voices (their microphone and the shopper's) and records with `MediaRecorder` (Opus, 24 kbps) only while consent stands; when the call ends it uploads the audio to `POST /admin/api/support/calls/:id/recording`. If the shopper takes consent back during the call, recording stops and nothing is kept. The server refuses an upload without consent, with recording switched off, over `SUPPORT_MAX_RECORDING_MB`, or that is not audio. Audio is stored in MongoDB (a document per call) or, when `ATTACHMENT_STORAGE=s3`, in the same private S3-compatible bucket as shopper files; it is deleted with the store's retention (`MESSAGE_RETENTION_DAYS`). It has no public address: the team plays it through an authorised request, the shopper through their own chat. Hosting cost: roughly 11 MB per hour of recorded call.

**Audio servers.** STUN is on by default (Google's public server). For shoppers behind strict networks you also need TURN: run [coturn](https://github.com/coturn/coturn) (free, self-hosted) or rent one, and set `SUPPORT_TURN_URLS` with either `SUPPORT_TURN_SECRET` (coturn `static-auth-secret`; short-lived credentials are made for each call) or `SUPPORT_TURN_USERNAME` and `SUPPORT_TURN_CREDENTIAL`. Without TURN, calls work on most networks but not every one. The dashboard tells the owner whether a relay is set up.

**Running more than one server instance.** The sockets of a shopper and a team member are held in memory by the instance they connected to, and the two must be on the same one (sticky routing on `/support-ws` by store, or a single instance). State of record (requests, calls, presence, recordings) is in MongoDB and survives restarts; a request, call or presence update made through a different instance than the sockets' is stored, but only the instance that holds the sockets can ring or signal them.

**Testing.** `test/supportService.test.js` (a real temporary `mongod` is started on a free port; the tests are skipped, not failed, when no `mongod` is installed, set `MONGOD_PATH` to point to one), `test/supportAuth.test.js`, and the existing suites. A full end-to-end run (real server, the real widget rendered from its Liquid block, the real dashboard, two Chrome pages and a real WebRTC audio call with a fake microphone) is described in `scripts/e2e-support.mjs` (and `scripts/live-llm-support.mjs`, which checks the real AI model).

## Run and test

```bash
cp .env.example .env   # fill in keys; every setting is listed there with its default
npm install
npm start
npm run check          # lint (eslint) + the whole test suite
```

`test/envExample.test.js` fails when the code reads a setting missing from `.env.example`, or the example lists one the code no longer reads.

## Deploy

- **Docker:** `docker build -t orbi-backend .` then `docker run --env-file .env -p 3000:3000 orbi-backend`. Runs as a non-root user, production dependencies only, health check on `/healthz`.
- **CI** (`.github/workflows/ci.yml`): lint and tests on Node 20 and 22, `npm audit` of production dependencies, Docker build.
- Behind a load balancer set `TRUST_PROXY_HOPS` to the number of proxies (Shopify's App Proxy counts as one).

## Monitoring

- `METRICS_TOKEN`: Prometheus metrics at `/metrics`. With `LLM_PRICES_JSON` the AI cost is reported per provider, model and purpose.
- `SENTRY_DSN`: errors to Sentry (redacted, at most one per error per minute).
- `ALERT_WEBHOOK_URL`: Slack/Discord alerts when every AI provider fails, an API key is rejected, a store reaches its AI ceiling or storage quota, MongoDB disconnects, the virus scanner is down, or the process crashes (each kind at most every `ALERT_MIN_INTERVAL_MINUTES`).
- Logs never carry what a shopper said (only its length; `LOG_CUSTOMER_TEXT=1` shows it redacted in development), and every console line has emails, phone numbers and personal fields masked.

## Call booking (calls in the owner's Google Calendar)

Off until the owner switches it on in Agent settings -> "Calls with your team". Then the agent can offer real free times
(`get_call_slots`), book one (`book_call`) and ask for a person (`flag_for_owner`). A request is saved as a `Booking`
(per shop); the owner confirms it in the dashboard (or "Confirm calls automatically" does), and confirming:

1. adds an event to the owner's Google Calendar (a stable event id, so a retry never doubles it), and
2. emails the shopper a confirmation with a calendar file (`.ics`).

One-time setup for the server: create a Google Cloud service account, enable the Google Calendar API, put its key file in
`GOOGLE_SERVICE_ACCOUNT_JSON` (raw JSON or base64). Each store owner then shares their calendar with the service account's
email ("Make changes to events") and pastes the calendar ID in Agent settings. Email uses the existing `EMAIL_USER` /
`EMAIL_APP_PASSWORD`. If either is missing the call is still saved and confirmable; the dashboard says what did not happen
and offers "Try again" (only the failed part is retried).

Everything the shopper sees (product cards, cart / checkout / order steps, booked calls) is stored with the transcript in
`Message.shown`, so the owner sees the same chat. Calls and chats are removed by the Shopify privacy webhooks and "Erase".

## Scaling notes

- Shared through MongoDB, so they hold across restarts and several instances: rate-limit counters, the one-time token list, live voice calls (`VOICE_MAX_PER_SHOP`, `VOICE_MAX_TOTAL` count every instance; a stopped instance's calls stop counting within a minute), webhook receipts and their retries.
- Per instance by design: the catalog cache (each instance fills its own) and the model cool-downs (each instance learns a failing model on its own).
- Voice limits (env, with defaults): `VOICE_MAX_PER_SHOP=25`, `VOICE_MAX_TOTAL=200`, `VOICE_MAX_MINUTES=30`, `VOICE_IDLE_SECONDS=180`, `VOICE_MAX_CHUNKS_PER_SECOND=40`.
- Uploads: `MAX_CONCURRENT_UPLOADS` per instance, `SHOP_ATTACHMENT_QUOTA_MB` per store; `ATTACHMENT_STORAGE=s3` moves file bytes out of MongoDB.

## Webhooks

Shopify gets its `200` as soon as a delivery is written down (by `X-Shopify-Webhook-Id`; a repeat is skipped). The work runs right after and is retried by the server with growing waits (`WEBHOOK_MAX_ATTEMPTS`, default 8; after the last one an alert goes out). Without MongoDB the work is done before answering, as before.

## Rotating the token encryption key

1. New key in `SHOPIFY_TOKEN_ENCRYPTION_KEY`, the old one in `TOKEN_ENCRYPTION_PREVIOUS_KEYS`; restart. Old tokens stay readable.
2. `node scripts/rotate-token-key.mjs --dry-run`, then without `--dry-run`: every stored token is re-encrypted with the new key.
3. Remove the old key from `TOKEN_ENCRYPTION_PREVIOUS_KEYS`.

## Code layout of the shopping agent

Big files were split into modules; the original file still re-exports everything, so every existing import keeps working.

- `src/industries/ecommerce.js`: the shopping session (`createSession`) and the module's exports. Around it, in `src/industries/ecommerce/`: `shared.js` (catalog functions and limits), `pricing.js` (checkout memory, quotes, order totals), `historyHints.js` (what earlier messages already say), `systemPrompt.js`, `toolDefinitions.js`, `replies.js` (wording helpers and product cards) and `analytics.js` (dashboard events and owner settings). The tool handlers are in `ecommerce/handlers/`: `catalog.js`, `cart.js`, `offers.js`, `checkout.js`, `orders.js`, `billing.js`; each gets the session's shared state through one `ctx` object.
- `src/tools/shopifyService.js`: product details, comparisons and cache upkeep. In `src/tools/shopify/`: `client.js` (Admin API, GraphQL, market prices), `caches.js`, `words.js` (reading what the shopper typed), `products.js` (shaping products, categories, stock), `search.js`, `catalog.js` (store info, catalog summary), `recommend.js`, `offers.js` (discounts), `policies.js`, `cart.js` (finding the exact variant).
- `src/agent/agent.js`: the model calls, the LangGraph graph, `runAgent`, greeting and suggestions. In `src/agent/core/`: `config.js` (settings from the environment), `clients.js` (LLM clients, auth-error blocks), `payload.js` (history and tool results as sent to the model), `toolsNode.js` (the tools step) and `turnPrep.js` (tool pruning, prefetch, greeting/suggestion prompts).

## Customer care: complaints, a person, a callback

**The flow.** The assistant first tries to solve a problem itself (it writes the problem down with `track_issue`: the customer's own words, order, product, what was already tried, so nothing is asked or suggested twice). When the customer repeats it, says it is still not solved or asks for a complaint, the assistant asks ONE question: email (the store gets it, the customer is copied) or a person. `raise_complaint` does the rest:

- `channel: "email"` (only after the customer said yes): one email to the store's support address (`notificationEmail`, else the store's contact email), `Cc` the customer, `Reply-To` the customer. Sent once per complaint (an atomic claim on the complaint), counted as sent only when the mail server accepted it. A failure (or no support email / no email on the server) is saved as `email_failed` / `not_configured`, flagged in the dashboard, sent to `ALERT_WEBHOOK_URL`, and the assistant is told to say it was NOT sent and to offer a person or a callback. The store can send it again from **Complaints**.
- `channel: "human"` (the customer refuses the email or wants a person): no email. The complaint travels with the call request (`SupportCall.reason` starts with `CMP-XXXXXX · order #…: summary`).

**Data.** `Complaint` (`src/models/Complaint.js`): one *open* complaint per chat of a store (unique partial index), with `email.status` (`none | needs_email | sending | sent | retrying | failed | not_configured | refused`) and `handoff.status` (`requested | connected | unavailable | callback | ended`). Logic in `src/services/complaintService.js`. Dashboard: **Complaints** (`/admin/api/complaints`, `src/public/admin/screens/complaints.js`). The owner can switch the whole thing off under Settings, "Raise complaints" (`raise_complaint`, `track_issue`).

**Callbacks live in the database.** The widget asks `POST /proxy/support/status` (it returns `callback` and `previousCallback`) on load, when the chat opens and when the tab comes back, and draws exactly that. `POST /proxy/support/callback` is idempotent per chat (a second click or a retry returns the same booking), one callback per chat, the slot is reserved atomically (unique `activeSlot`). `POST /proxy/support/callback/cancel` and `/callback/reschedule` act only on the booking of the same chat. `calendar` (the owner's Google Calendar) is reported separately from `confirmed`.

**Voice.** What the voice server writes down while the assistant is still speaking is checked against the assistant's own sentence (`isLikelyEcho` in `src/voice/transcriptUtils.js`, and the same rule in the widget): the assistant's own words are ignored, other words interrupt it. While the browser's own speech synthesis speaks (the browser cannot cancel that echo) an acoustic interruption must be clearly louder, and the words from the server decide (barge-in candidate).

## Customers and call accountability

The dashboard's **Calls** screen and each customer's page read from the real call records (never estimates).

**Who a customer is.** Only a signed-in Shopify customer is *verified* (the id comes from the signed App Proxy request, then Shopify confirms it). A visitor is recognised only by their browser cookie (`Visitor (this browser)`): if they clear cookies, use incognito or another device they appear as a new visitor, and nothing links the two. A typed email is never proof of identity, so it never merges people; such a person shows as `Guest (email not verified)`. Linking a visitor to a person after cookie loss needs a verified email/phone (OTP) or a Shopify sign-in; that is not built yet. `personFilter` (src/services/people.js) is the one place that would learn aliases.

**What a call is.** `SupportCall` = a shopper asked for a person. Outcomes: *waiting*, *live*, *completed* (connected and ended), *missed* (nobody answered in time), *failed* (audio could not connect), *cancelled* (the shopper gave up first). Waiting and cancelled are never counted as missed. A callback (`Booking`) is not a call. An **AI voice session** is an `ai_voice_session` event written when the voice connection closes (none if the shopper said nothing). A voice session passed to a person and that person's call are **one** support interaction (`/admin/api/call-analytics`, `interactions`).

**Who handled it.** `assignedTo` / `handledBy` are `{type: human|ai, id, name}` with the team member's stable Shopify user id and the name at the time; `handlingSegments` records when they took it and let go. Calls saved before this existed are read through `representative`, nothing is rewritten. A call is taken by one person today; transferring a connected call to someone else (which needs the audio to reconnect) is not built, so `transfers` is always empty.

**How long the numbers go back.** Call details are kept for the store's retention period (`logging.retentionDays`, default 90 days). Each finished call also writes a small `support_call_closed` event with no personal data, kept `EVENT_RETENTION_DAYS` (default 400). A date range reaching past the detailed records says so and shows the longer-term counts from those events.

**Erasing a person** also removes their name/contact/reason from their call records, deletes their complaints and recordings, and unlinks their events (counts stay).

For calls recorded before this: `node scripts/backfill-support-calls.mjs` (dry run) then `--apply`. It adds the customer key and the short closed-call events. It does not (and cannot) reconnect a visitor to a person after cookies were cleared.
