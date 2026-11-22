# Orbi AI: Project Guide for Interviews (2.5 years experience)

Is document ko padho, phir bina dekhe bolna practice karo. Har section me **What** (kya bana), **Why** (kyun aisa), aur **Interviewer kya pooch sakta hai** diya hai.

> **Sabse zaroori rule:** sirf wahi bolo jo tum samjha sakte ho. Interviewer kisi bhi cheez par "aur andar kaise kaam karta hai?" pooch sakta hai. Jo cheez abhi bani nahi (section 14), usko "built" mat bolo. Plan bolo. Isse tumhari credibility badhti hai, ghat'ti nahi.
> Agar poochhe ki AI tools use kiye ya nahi: seedha bolo ki haan use kiye, par design decisions, debugging aur testing tumne samjhe aur kiye. Phir koi bhi ek file kholkar samjha sako.

---

## 1. 60-second pitch (yahi pehle bolna)

"Maine **Orbi AI** banaya hai. Ye Shopify stores ke liye ek AI shopping assistant hai. Store ki website par ek chat widget hota hai jisme shopper text ya voice se baat karta hai. AI products dhundhta hai, cart me add karta hai, order ka status batata hai aur checkout tak le jata hai. Agar AI sambhal nahi paya to shopper ek asli insaan se **live audio call** (WebRTC) kar sakta hai, ya callback book kar sakta hai, ya complaint raise kar sakta hai.

Store owner ke liye Shopify admin ke andar ek **dashboard** hai: conversations, orders, customers, calls, complaints aur AI ki settings. Backend Node.js, Express aur MongoDB par hai. AI agent LangGraph par chalta hai, Gemini primary model hai. Poora system **multi-tenant** hai: ek server par kai stores, aur ek store doosre ka data kabhi nahi dekh sakta."

## 2. 3-minute version (agar poochhe "thoda detail me batao")

1. **Problem:** Online stores par shopper ko jawab turant chahiye (size, stock, shipping, order status). Staff 24 ghante nahi hota. Chatbot aksar galat jawab deta hai ya bas FAQ bolta hai.
2. **Solution:** Ek agent jo store ka asli catalog aur orders Shopify se live padhta hai, aur jahan zarurat ho wahan insaan ko bulata hai.
3. **Mere hisse ka kaam:** backend, agent ka logic, voice, live calls, dashboard, security, testing.
4. **Sabse mushkil hissa:** AI ko **jhoot bolne se rokna** (hallucination), voice me **echo**, aur real-time calls ko **reliable** banana.
5. **Result:** 1042 automated tests, real browser aur real Shopify dev store par test hua.

---

## 3. Architecture ek nazar me

```
Shopper ka browser                        Store owner / staff
 (Shopify store page)                      (Shopify admin ke andar)
  Chat widget (theme app extension)         Dashboard (embedded app)
        |  App Proxy (signed)                      |  Shopify session token (JWT)
        v                                          v
 +--------------------------- Node.js + Express backend ---------------------------+
 |  /proxy/*  (shopper APIs)     /admin/api/*  (owner APIs)    /support-ws (WebSocket)|
 |  Agent (LangGraph + tools)    Support hub (WebRTC signalling)  Voice WS (Gemini)  |
 +-----+------------------+---------------------+------------------+---------------+
       |                  |                     |                  |
    MongoDB           Shopify Admin API     Gemini / Claude     TURN server (relay)
 (conversations,      (products, orders,    (LLM + Gemini Live)
  calls, events...)    customers, drafts)
```

**Do repositories:**
- `mini-agent`: backend + dashboard.
- `shopify-widget/ai-commerce-agent`: Shopify theme app extension (storefront widget).

**Why ye structure:** Shopify me widget ko store ke theme me chalana padta hai (theme app extension), isliye alag repo. Backend ek hi hai jo sab stores serve karta hai.

---

## 4. Tech stack aur "Why"

| Cheez | Kya use kiya | Kyun |
|---|---|---|
| Backend | Node.js + Express | Real-time (WebSocket) aur I/O-heavy kaam (LLM, Shopify API) ke liye event loop accha hai. JS poore stack me ek hi. |
| Database | MongoDB + Mongoose | Chat, events aur call records flexible hote hain. TTL indexes se purana data apne aap delete hota hai. Atomic updates aur unique indexes se race conditions rokte hain. |
| AI agent | LangGraph (tool-calling) | Agent ko kai step chalane hote hain (search, cart, checkout). Graph me flow, retry aur tools saaf rehte hain. |
| LLM | Gemini (primary), Claude (secondary option) | Gemini Live voice ke liye. Secondary isliye ki ek provider down ho to chat band na ho. |
| Voice | Gemini Live over WebSocket | Low-latency bidirectional audio. |
| Live calls | WebRTC + TURN | Audio browser-to-browser jata hai (server par load nahi). TURN ke bina strict network par call fail hoti hai. |
| Frontend (dashboard, widget) | Vanilla JS modules + Tailwind (build) | Widget ko store ke page par halka rehna hai, koi bada framework nahi. |
| Email | Nodemailer (SMTP) | Complaint, booking emails. |
| Calendar | Google Calendar (service account) | Callback booking owner ke calendar me jaye. |
| Tests | `node --test` + throwaway `mongod` + Playwright | Real DB par atomic/unique-index behaviour test hota hai, mock se nahi. |
| Ops | Dockerfile, GitHub Actions, ESLint, Prometheus metrics, Sentry | Production ke liye. |

**Interviewer pooch sakta hai: "Mongo hi kyun? SQL kyun nahi?"**
Jawab: Hamara data document-shaped hai (chat + messages + events, flexible props). TTL index se retention policy DB khud sambhalta hai. Jahan transactions chahiye the (do log ek call lein) wahan maine single-document atomic updates (`findOneAndUpdate` with conditions) aur unique indexes use kiye, to multi-document transaction ki zaroorat nahi padi. Agar financial ledger hota to SQL choose karta.

---

## 5. Multi-tenancy aur Security (sabse zyada poochha jata hai)

### What
Ek server par kai Shopify stores. Har record me `shop` field. **Har query me `shop` filter.** Shop ka naam kabhi user ke bheje hue body/URL se nahi liya jata.

### Why
Agar ek store ka owner kisi tareeke se doosre store ka data dekh le, to ye data leak hai. Isliye shop sirf **verified credential** se nikalta hai:

| Kaun | Credential | Kaise verify |
|---|---|---|
| Shopper (widget) | **App Proxy signature** | HMAC-SHA256 (sorted params, app secret), timestamp 5 minute ke andar |
| Store owner (dashboard) | **Shopify session token** (JWT HS256) | Signature, `aud` = app client id, `iss`/`dest` host match, `exp`/`nbf` |
| Call window | Ek-baar ka ticket, phir console token | Ticket 2 minute, replay-guard (ek hi baar use) |
| Voice | Chhota-sa voice token | Short expiry, shop aur customer ke saath bandha |

### Aur security cheezein
- **Offline access token encrypted at rest** (AES), key rotation support.
- **Rate limits:** per shop, per shopper, aur login jaise routes par.
- **Console token ki limit:** sirf call lene wale routes (whitelist), orders/settings nahi.
- **Logged-in customer sirf signed proxy se:** `logged_in_customer_id` ko browser ki baat par nahi mana, Shopify Admin API se confirm hota hai.
- **File uploads:** content check, optional ClamAV virus scan, files ko page ki tarah serve nahi karte (sandbox CSP, `nosniff`).
- **Prompt injection:** shopper ka likha text "untrusted" mark hota hai, AI ko instruction nahi maana jata.
- **Privacy:** retention TTL, "delete personal data" (`erasePerson`), recording sirf consent ke baad.

**Interview Q: "Agar koi `shop` parameter badal de to?"**
Jawab: Backend usko padhta hi nahi. `req.shop` sirf signed token/signature se aata hai. Tests me ye cross-shop isolation check hota hai (do store ka data banakar, ek ke credential se doosre ka maanga, 404/empty aata hai).

**Interview Q: "JWT verify kaise kiya?"**
Jawab: Sirf HS256 allow, `none` ya doosra algorithm reject. Signature `timingSafeEqual` se compare, phir expiry, not-before, audience aur issuer/dest match. Error ka reason caller ko nahi batate.

---

## 6. AI Agent: kaise kaam karta hai

### What
Shopper ka message aata hai, agent history ke saath model ko bhejta hai. Model **tools** call karta hai (search products, add to cart, check order, raise complaint, request human). Tool results se model jawab banata hai. Jawab ke saath product cards aur actions (cart add, checkout link) widget ko jate hain.

### Why tools
LLM ko apne dimaag se prices ya stock nahi batane chahiye. Tools Shopify se **live data** laate hain. Isse jawab sach hota hai.

### Reliability ke liye jo maine banaya
1. **Fact guard (spec hallucination rokna):** Agar model koi product spec bole jo catalog me nahi hai, guard uska jawab rokta ya sudharta hai.
2. **Availability guard:** "stock me hai" tabhi jab data kahe.
3. **Same-kind guard / card selection:** Cards me wahi product dikhte hain jo jawab me hain (price/card mismatch bug fix hua).
4. **Request guards:** Galat ya risky request pehle hi pakad li jati hai.
5. **Model health aur fallback:** Primary model 503/429 de to retry/secondary. "Degraded" reply honestly batata hai ki problem hui, jhoota jawab nahi deta.
6. **Deterministic path:** Kuch simple cheezein (greeting, cart add confirmation) model ke bina.
7. **Hardcoded word lists ka sawal:** Gender jaise kuch heuristics abhi word list par hain. Isko model-derived karna improvement list me hai. (Honest raho.)

### Customer care flow (complaints)
Agent step by step: problem samjho, troubleshoot karo, agar fail ho to customer se poochho email ya insaan. **Customer ki agreement ke bina email nahi.** Email sirf tab "sent" gina jata hai jab SMTP ne accept kiya. Fail ho to alert/flag, dashboard me retry.

**Interview Q: "LLM hallucinate kare to kaise rokte ho?"**
Jawab (3 layer): 1) Facts tools se aate hain, model se nahi. 2) Output ke baad guards spec/stock claims verify karte hain. 3) Jahan data nahi, agent saaf bolta hai "mujhe pata nahi" aur human ya callback offer karta hai. Aur testing real catalog par ki.

**Interview Q: "Cost aur latency kaise sambhalte ho?"**
Jawab: Per-shop aur per-shopper rate limits, caches (catalog 2 min, store info 10 min, policies 30 min), voice session ki duration/idle limits, direct deterministic path jahan model chahiye hi nahi.

**Interview Q: "Model down ho jaye to?"**
Jawab: Retry, secondary provider (config me), aur degraded reply. Maine ek risk khud pakda tha ki secondary key set nahi hone se fallback kaam nahi karta. Isliye `ANTHROPIC_API_KEY` bharna deployment checklist me hai.

---

## 7. Currency aur Shopify Markets (ek real bug)

### Problem
Store ki base currency USD thi, par India market me prices ₹ me fixed the. Checkout calculation delivery country ke market ke hisaab se chal rahi thi, to widget me $ dikhta aur order ₹ me ban jata.

### Fix
Draft order calculate karte waqt hamesha cart ki currency (`presentmentCurrencyCode`) bheji. Prices, order aur email teeno same currency me. Real orders (#1024, #1025) se verify kiya.

### Why important
Paisa galat dikhana trust aur legal dono ka issue hai.

**Interview Q: "Sabse tricky bug?"** Ye ek achcha jawab hai: symptom (price mismatch), root cause (Markets pricing follows delivery country), fix, aur kaise verify kiya (real dev store ke orders).

---

## 8. Voice (Gemini Live)

### What
Browser mic audio ko WebSocket se backend ko bhejta hai, backend Gemini Live se baat karta hai, audio wapas aata hai. Transcripts se agent tools chalte hain.

### Mushkil cheezein jo maine solve ki
1. **Echo bug:** Assistant jo bol raha tha uska transcript "shopper ne bola" mana ja raha tha, to agent apni hi baat par jawab deta. Fix: **fuzzy echo detection** (words aur bigram overlap, jitni der assistant bol raha hai usi window ke andar). Server aur widget dono me. Test me pehle reproduce kiya (guard ke bina fail), phir fix.
2. **Barge-in:** Shopper beech me bole to assistant ruk jaye, par echo se na ruke. Acoustic threshold + transcript confirm.
3. **Limits:** Per shop concurrent sessions, max duration, idle timeout (forgotten tab paid connection na rakhe). Instances ke beech count.
4. **Voice session record:** Har session ka chhota event (duration, turns, kya insaan ko pass hua).

**Interview Q: "Echo kaise pakda?"** Reproduce karne ke liye fake speech test likha, pata chala ki server ka transcript hi echo hai. Exact match kaam nahi karta kyunki STT words badal deta hai, isliye fuzzy overlap. Digits ke liye sirf exact run (taaki phone number galat na kate).

---

## 9. Live human calls (WebRTC)

### What
Shopper "talk to a person" bolta hai. Agar team me koi online hai, call request banti hai, team ke browsers ring karte hain, jo pehle accept kare uski call ho jati hai. Audio WebRTC se browser-to-browser. Optional recording (consent ke baad).

### Call ka lifecycle
```
requested -> accepted -> connected -> ended
requested -> cancelled        (shopper ne chhod diya)
requested -> unanswered       (kisi ne nahi uthaya)
accepted/connected -> failed  (audio nahi bana ya side gir gayi)
```

### Design choices aur Why
- **Har state change ek atomic update** (`findOneAndUpdate` with condition). Do log ek saath accept karein to ek hi jeete. Doosre ko clear message.
- **Unique index `openKey`:** ek chat ki ek hi open request ho sakti hai (duplicate click se do request nahi).
- **Presence heartbeat + sweeper:** browser band ho jaye to banda hamesha "online" na rahe. Har kuch second me sweeper unanswered/vanished calls band karta hai.
- **Signalling server par, audio P2P:** server par audio ka bojh nahi.
- **TURN:** Strict NAT/firewall me direct connection nahi banta. TURN relay se audio jati hai (encrypted, DTLS-SRTP). Free Metered TURN use kiya (500 MB/month, 1 minute call ~1 MB).
- **Call window alag:** Shopify admin iframe me mic permission nahi deta, isliye call alag browser window me.

### Ek real debugging kahani (interviewer ko pasand aati hai)
"Phone aur laptop dono same WiFi par the, fir bhi 'audio connection failed'. Maine ICE candidate types (host/srflx/relay) ko call record me log karwaya. Root cause code nahi tha: **Windows Firewall ki ek Block rule** (`codex_sandbox_offline_block_inbound`) saare non-loopback inbound ko block kar rahi thi, aur Block rule Allow se upar hoti hai. Permanent fix ke liye TURN set kiya."

**Interview Q: "STUN aur TURN me fark?"**
STUN browser ko apna public address batata hai, direct P2P ke liye. TURN relay hai: jab direct fail ho, audio TURN server se guzarti hai. TURN outbound hota hai, isliye firewall se bhi chal jata hai.

**Interview Q: "Do log ek saath accept karein to?"**
Presence me "free" claim aur call par `status: requested` condition, dono atomic. Jo condition me fail hota hai use "taken" milta hai. Test me concurrent accept kiya.

**Interview Q: "Recording kaise handle ki?"**
Shopper se consent. Consent ke bina record nahi. Withdraw kare to ruk jaye. Audio Mongo (chhoti) ya S3 me, sirf dashboard se authorized access, retention ke baad delete.

---

## 10. Callback booking (Google Calendar)

### What
Agar koi online nahi, shopper time slot chunkar callback book karta hai. Owner ke calendar me event, email dono ko.

### Design
- **Idempotent:** ek chat ki ek active booking. Confirm 3 baar daba do to 1 hi banegi.
- **Slot race:** `activeSlot` par unique index, do shopper ek hi slot nahi le sakte.
- **Booking DB se wapas aati hai:** page refresh ya reopen par `/support/status` se state aati hai (browser memory par nahi).
- Cancel/reschedule sirf usi chat se.
- Calendar sync fail ho to booking confirmed rehti hai, calendar status alag ("failed") dikhta hai.

**Interview Q: "Double click par duplicate kaise rokte ho?"** Idempotent create plus unique index. Pehle ye 409 deta tha, maine replay logic daali: duplicate key error aaye to maujooda booking wapas do.

---

## 11. Dashboard aur Customer 360

### What
Owner ke liye: Home (numbers), Conversations, Orders & Customers, **Calls**, Complaints, Bookings, Catalog insights, AI quality, Train, Widget, Settings.

### Customer identity (important aur honest)
Customer ki pehchan `personKey`:
- `c<id>`: **Shopify login** (verified, signed). Cookie delete hone par bhi wapas pehchana jata hai.
- `v<browser>`: **visitor**, sirf us browser ki cookie se. Cookie delete to naya visitor. Ye fix nahi ho sakta bina login ya verification.
- `e<hash>`: **typed email**. Ye proof nahi, isliye "Guest (email not verified)" label, merge nahi.

**Why:** unverified email par history merge karne se kisi ka data doosre ko dikh sakta hai.

### Call accountability
Har call me: kisne maangi, kisko assign hui, kisne handle ki (stable staff ID + naam snapshot), timestamps, duration, outcome. Outcomes: waiting, live, completed, missed, failed, cancelled. **Waiting aur cancelled kabhi "missed" nahi.** Callback call count me nahi. AI voice session aur use jis insaan ko pass kiya wo **ek hi interaction** ginti hai (double count nahi).

### Lifetime data aur TTL
Call details retention (default 90 din) ke baad delete. Isliye har call band hone par PII-free `support_call_closed` event likha jata hai (400 din). Dashboard saaf batata hai ki kaunsa count kitne din ka hai.

**Interview Q: "Aggregation kaise kiya?"** MongoDB aggregation pipeline: `$match` (shop + range), `$addFields` outcome (`$switch`), `$group`. Index `{shop, personKey, requestedAt}` aur `{shop, handledBy.id, requestedAt}`.

---

## 12. Testing aur Quality

- **1042 automated tests**, sab pass. `npm test` = `node --test`.
- **Real MongoDB** (throwaway `mongod`) jahan atomic updates aur unique indexes test karne hain.
- **Real browser (Playwright/Chromium)** se widget aur dashboard test kiye: scroll, callback persistence, echo guard, call console, Customer 360 UI.
- **Real data:** dev Shopify store par real orders, real Gemini, real SMTP.
- Test jo **bug ke bina fail hona chahiye** (jaise echo guard hata do to test fail), ye maine verify kiya.
- ESLint clean.

**Interview Q: "Mock kyun nahi?"** Unique index aur atomic updates ki behaviour mock me nahi aati. Race condition ka bug mock me chhup jata.

**Interview Q: "Test me kya bug pakda?"** Ek example: customer-wise interaction count me query me sirf `_id` select kiya tha, to `connectedAt` missing tha aur count 1 aata tha (2 chahiye). Test ne pakda.

---

## 13. Production aur Ops

- **Docker** image, **GitHub Actions** CI.
- **Config validation** startup par (kya env missing hai, warning).
- **Metrics** (`/metrics`, token se protected), **Sentry** errors, **alert webhook**.
- **Graceful degraded behaviour:** DB down ho to chat crash nahi karta.
- **Scaling note:** Support hub sockets ek process me rehte hain. Kai servers ke liye sticky routing chahiye (README me likha).
- **Deploy checklist:** `shopify app deploy` (widget), env keys, METRICS_TOKEN, SENTRY_DSN, S3, real APP_URL, support email setting.

---

## 14. Jo abhi BANA NAHI HAI (honest raho)

Interview me ye seedha bolo. Isse tum mature dikhte ho.

| Cheez | Status |
|---|---|
| Staff Support Portal (alag login, roles) | Sirf architecture/plan |
| Verified email/phone OTP se visitor recovery | Nahi bana |
| Call transfer (ek employee se doosre ko) | Data fields hain, asli transfer nahi |
| Multi-industry (clinic, restaurant) | Neev hai (industry registry), par abhi sirf ecommerce |
| Smart call routing, waiting queue | Plan |
| Secondary LLM fallback | Code hai, par key set nahi hui thi |
| Real Google Calendar, do alag network par call, asli mic echo | Poora test nahi hua |

**"Aage kya improve karoge?"** ka jawab yahi list hai, priority ke saath (security aur reliability pehle).

---

## 15. Top 30 interview questions (short model answers)

1. **Project kya hai?** Section 1.
2. **Aapka role?** Poora backend, agent logic, voice, calls, dashboard, security aur tests. (Jo sach hai wahi bolo.)
3. **Sabse mushkil challenge?** Voice echo ya Markets currency ya firewall/TURN. Ek chuno, root cause se fix tak batao.
4. **Multi-tenant isolation kaise?** Section 5.
5. **Auth kaise?** App Proxy HMAC, Shopify session JWT, console ticket.
6. **LLM hallucination?** Tools + guards + honest fallback.
7. **Prompt injection?** Shopper text untrusted, tools ke permissions backend par (agent customerAgreed ke bina email nahi bhej sakta, tool handler khud check karta hai).
8. **Race condition kahan thi?** Call accept, booking slot, duplicate complaint. Atomic update + unique index.
9. **Idempotency?** Booking replay, complaint ek-open-per-chat, email outbox.
10. **Database indexes?** `{shop,...}` compound, unique partial indexes, TTL.
11. **TTL kyun?** Retention aur privacy automatic.
12. **WebSocket vs HTTP?** Real-time signalling aur voice ke liye.
13. **WebRTC kaise?** Signalling server par, media P2P, TURN fallback.
14. **STUN/TURN?** Section 9.
15. **Browser me mic Shopify iframe me kyun nahi?** Iframe par `allow` permission nahi hoti, isliye call window alag.
16. **Rate limiting?** Per shop/shopper, key `shop|visitor`, IP bucket fallback.
17. **Error handling/degradation?** DB down, model down, SMTP fail, Calendar fail: sab ke honest fallbacks.
18. **Testing strategy?** Section 12.
19. **Scaling?** Stateless HTTP; hub ke liye sticky; Mongo indexes; caches.
20. **Cost control?** Limits, caches, deterministic path.
21. **Logging aur monitoring?** Metrics, Sentry, alert webhook, ICE diagnostics.
22. **Data privacy/GDPR?** Retention, erase, consent, PII-free events.
23. **Aapne kya galat kiya aur seekha?** Example: pehle `e<hash>` key se unverified email se admin me log merge ho rahe the, maine usse "unverified" label diya aur merge claim nahi kiya.
24. **Agar 50 staff ho to?** Staff portal plan: alag login, roles, call-scoped data, server-side sessions.
25. **Multi-industry?** Industry registry hai; platform aur industry alag karna padega.
26. **Event loop kaise kaam karta hai?** (Node basic) Single thread, async I/O, microtask vs macrotask.
27. **Promise.all vs sequential?** Independent queries parallel (dashboard load me), dependent sequential.
28. **N+1 query kaise bachaya?** Aggregation aur `$in` queries (customer list me page ke keys ke liye ek hi call-count query).
29. **Security me aapne kya galti pakdi?** Console token ka scope (koi bhi conversation padh sakta tha) staff ke liye khatarnak, isliye call-scoped design.
30. **Agar 1 hafte me deploy karna ho?** Env/keys checklist, secondary LLM key, METRICS_TOKEN/Sentry, TURN, backup, aur load test.

---

## 16. Node/Mongo basics jo is project se jodkar bolna

- **Event loop:** LLM/Shopify calls async hain, isliye ek process bahut users handle karta hai. CPU-heavy kaam (audio processing) bahar rakha.
- **`async/await` errors:** har route `wrap()` me, taaki unhandled rejection crash na kare.
- **Mongoose:** schema, indexes, `lean()`, `findOneAndUpdate` atomic, aggregation.
- **Indexing:** query pattern ke hisaab se compound index (`shop` pehle).
- **Transactions kab nahi:** single-doc atomic ho to zaroorat nahi.
- **Streams/Buffers:** audio recording ke bytes.
- **Security basics:** HMAC, JWT, timing-safe compare, CSRF/XSS awareness.

---

## 17. Numbers jo yaad rakho

- Tests: **1042** pass.
- Rate limits: chat 30/min per shopper, shop 240/min.
- Call request expiry: **90 sec**; presence fresh: **45 sec**.
- Retention: messages 90 din default (7 to 365), events 400 din.
- Console ticket: **2 min**; console session: ~10 ghante.
- App Proxy timestamp tolerance: **5 min**.
- Free TURN: 500 MB/month, ~1 MB per minute audio.

---

## 18. Practice plan (3 din)

1. **Din 1:** Sections 1 to 5 bolke yaad karo. 60-sec pitch bina dekhe.
2. **Din 2:** Sections 6 to 11. Har section ka ek "bug story" bolo.
3. **Din 3:** Section 12 to 15. Questions ko khud se pucho, jawab loud bolo. Section 14 ko honestly bolna practice karo.

Aur ek kaam: code kholo aur in files ko ek baar padho taaki "dikhao" bole to dikha sako:
`src/admin/auth.js`, `src/services/supportService.js`, `src/models/SupportCall.js`, `src/admin/callAnalytics.js`, `src/voice/transcriptUtils.js`, `src/services/bookingService.js`, `src/agent/factGuard.js`.
