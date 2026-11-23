import fs from "node:fs";
import "dotenv/config";
import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { recordVoiceSession, newVoiceSessionId } from "./src/services/voiceSessionLog.js";
import { WebSocket, WebSocketServer } from "ws";
import { connectDB } from "./src/database/db.js";
import { verifyEmailTransport, retryKeptEmails } from "./src/services/emailService.js";
import shopifyProxyRoutes from "./src/routes/shopifyProxyRoutes.js";
import uploadRoutes from "./src/routes/uploadRoutes.js";
import { complianceWebhook, ordersCreateWebhook, ordersCancelledWebhook, refundsCreateWebhook } from "./src/routes/shopifyWebhookRoutes.js";
import { webhookQueue } from "./src/services/webhookQueue.js";
import { createAdminRouter } from "./src/admin/routes.js";
import { renderShell } from "./src/admin/shell.js";
import { createSupportServer, SUPPORT_PATH } from "./src/services/supportWs.js";
import { consoleSessionHandler } from "./src/admin/supportRoutes.js";
import rateLimit from "express-rate-limit";
import { supportHub, startSupportSweeper } from "./src/services/supportRuntime.js";
import { connectGeminiLive } from "./src/voice/liveTranscriptionService.js";
import { createLiveSessionManager } from "./src/voice/liveSessionManager.js";
import { createTranscriptWatchdog } from "./src/voice/transcriptWatchdog.js";
import { isLikelyEcho } from "./src/voice/transcriptUtils.js";
import { createTranscriptFilter } from "./src/voice/transcriptFilter.js";
import { createSpeechActivity } from "./src/voice/speechActivity.js";
import { runAgent, sanitizeHistory, isFallbackAnswer } from "./src/agent/agent.js";
import { prepareVoiceFiles } from "./src/voice/voiceFiles.js";
import shopifyOAuthRoutes, {
  exchangeSessionTokenForOfflineToken,
  needsOfflineToken,
  extractShopFromIdToken,
  handleAppUninstalledWebhook,
  isValidShopDomain,
} from "./src/routes/shopifyOAuthRoutes.js";
import {
  isActiveStore,
  normalizeShopDomain,
} from "./src/services/storeIntegrationService.js";
import { prewarmStore } from "./src/tools/shopifyService.js";
import { voiceUpgradeOptions } from "./src/voice/voiceAuth.js";
import { storefrontOriginCheck } from "./src/http/storefrontCors.js";
import { resolveShopifyCustomer } from "./src/services/shopifyCustomerService.js";
import { guestCustomer, verifiedCustomerGid, resolveClientId, nextClientId } from "./src/services/customerContext.js";
import { resolveTurnLanguage, isLanguageCode } from "./src/services/language.js";
import mongoose from "mongoose";
import { createVoiceGovernor, createSharedVoiceGovernor } from "./src/voice/voiceGovernor.js";
import VoiceSession from "./src/models/VoiceSession.js";
import { validateEnv } from "./src/config/env.js";
import { createLogger, customerText, installConsoleRedaction } from "./src/utils/logger.js";
import {
  securityHeaders,
  createHealthHandlers,
  installGracefulShutdown,
  envCount,
} from "./src/http/hardening.js";
import { attachmentStorage } from "./src/services/objectStorage.js";
import { sweepExpiredObjects, sweepExpiredRecordings } from "./src/services/attachmentService.js";
import { httpMetrics, metricsHandler, installProcessGauges, gauge, inc } from "./src/observability/metrics.js";
import { alert } from "./src/observability/alerts.js";
import { reportError } from "./src/observability/errors.js";


// Every log line in this process: emails and phone numbers redacted, personal fields masked.
installConsoleRedaction();
const log = createLogger("server");

const app = express();
const server = createServer(app);
// The voice token is checked (and used up) during the handshake, before any audio is accepted.
// The voice slot is taken during the handshake too, counted across every instance (see voiceGovernor.js).
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, ...voiceUpgradeOptions({ admit: (shop) => voiceGovernor.acquire(shop) }) });
// Live help from a person has its own socket (/support-ws: shoppers and the team's dashboards, signalling for browser
// to browser audio). Every other upgrade goes to the voice server exactly as before.
const supportServer = createSupportServer({ hub: supportHub() });
server.on("upgrade", (req, socket, head) => {
  let path = "/";
  try { path = new URL(req.url || "/", "http://localhost").pathname; } catch { /* the voice server refuses it */ }
  if (path === SUPPORT_PATH) return void supportServer.handleUpgrade(req, socket, head);
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

const PORT = process.env.PORT || 3000;

// Behind ngrok / a load balancer: trust the first proxy hop so req.ip and https detection are right.
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS ?? 1));
app.disable("x-powered-by");
app.use(securityHeaders);
let shutdownState = { isShuttingDown: () => false };
const health = createHealthHandlers({ mongoose, isShuttingDown: () => shutdownState.isShuttingDown() });
app.get("/healthz", health.liveness);
app.get("/readyz", health.readiness);
// Prometheus metrics, only with METRICS_TOKEN (404 without it)
app.get("/metrics", metricsHandler());
app.use(httpMetrics);
installProcessGauges();

export async function isActiveShop(shop) {
  return isActiveStore(shop);
}

// Webhook bodies (a large order) can be bigger than a chat message; they are checked by signature, not size.
app.use("/api/shopify/webhooks", express.json({ limit: "5mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(
  express.json({
    limit: "128kb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Helpful redirect if someone accidentally prefixes /api/shopify-chat before /api/shopify/oauth
app.use("/api/shopify-chat/api/shopify/oauth", (req, res) => {
  const target = `/api/shopify/oauth${req.url || ""}`;
  return res.redirect(302, target);
});

// Shopify OAuth & Webhook endpoints (mounted before storefront Origin CORS check)
app.use("/api/shopify/oauth", shopifyOAuthRoutes);
app.post("/api/shopify/webhooks/app-uninstalled", handleAppUninstalledWebhook);
app.post("/api/shopify/webhooks/compliance", complianceWebhook);
app.post("/api/shopify/webhooks/orders-create", ordersCreateWebhook);
app.post("/api/shopify/webhooks/orders-cancelled", ordersCancelledWebhook);
app.post("/api/shopify/webhooks/refunds-create", refundsCreateWebhook);
app.post("/webhooks/app/uninstalled", handleAppUninstalledWebhook);

// Shopify App Entry URL: automatically registers/installs a new store when opened from Shopify Admin
app.get("/", async (req, res) => {
  const idToken =
    typeof req.query?.id_token === "string" ? req.query.id_token.trim() : "";
  const shop =
    normalizeShopDomain(req.query?.shop) || extractShopFromIdToken(idToken);

  if (shop && isValidShopDomain(shop)) {
    // only when the stored token is missing, expiring, short of a scope or due for a refresh
    if (idToken && (await needsOfflineToken(shop).catch(() => true))) {
      try {
        await exchangeSessionTokenForOfflineToken(shop, idToken, req);
        console.log(`[Shopify Managed Install] Registered & synced store: ${shop}`);
      } catch (err) {
        console.warn(
          `[Shopify Managed Install] Token exchange fallback to OAuth for ${shop}:`,
          err.message
        );
      }
    }

    const active = await isActiveShop(shop);
    if (!active) {
      const embeddedFlag = req.query?.embedded === "1" ? "&embedded=1" : "";
      return res.redirect(
        `/api/shopify/oauth/install?shop=${encodeURIComponent(shop)}${embeddedFlag}`
      );
    }
  }

  res.setHeader("Cache-Control", "no-store");
  return res.type("html").send(renderShell());
});

app.use(express.static("src/public", { index: false }));

// The store owner's dashboard API: same-origin inside Shopify admin and signed with a Shopify session
// token, so it sits before the storefront CORS check (which is for shoppers' stores).
app.use("/admin/api", createAdminRouter());
// the call window swaps its one-time ticket for a session (same origin; the ticket itself is the proof)
app.post("/support-console/session", rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }), consoleSessionHandler());

// Storefront CORS: only a connected, active store's own https domain (localhost outside production).
const storefrontCors = cors({ origin: storefrontOriginCheck({ isActive: (host) => isActiveShop(host) }) });

app.use(storefrontCors);
app.use("/proxy", shopifyProxyRoutes);
// A standalone website of the store (Render static site): same handlers, one configured store, guests only. Off unless PUBLIC_STOREFRONT_SHOP is set.
app.use("/public", shopifyProxyRoutes);
app.use("/api/uploads", uploadRoutes);

// How long to wait after the shopper's words before answering. Gemini Live itself already waits for
// the end of speech (silenceDurationMs) before it says the turn is complete, so after a complete turn
// only a short wait is added; a chunk without "turn complete" waits a bit longer. Whether the shopper
// is done is then read from the microphone, the same in every language: while their voice is still
// coming in, the answer waits (up to VOICE_MAX_EXTRA_WAIT_MS more). If they start again after the
// answer began, the answer is cancelled and both parts are answered together.
const TRANSCRIPT_SETTLE_MS = envCount("VOICE_SETTLE_MS", 1000) || 1000;
const TURN_COMPLETE_SETTLE_MS = envCount("VOICE_TURN_COMPLETE_SETTLE_MS", 400) || 400;
// a pause between two sentences is often 0.4-0.7 s: anything shorter than this still counts as "the shopper is talking"
// (350 ms cut "I want to check out with cash on delivery. Use my previous address." after "cash", live test 2026-11-22)
const STILL_SPEAKING_MS = envCount("VOICE_STILL_SPEAKING_MS", 800) || 800;
const MAX_EXTRA_WAIT_MS = envCount("VOICE_MAX_EXTRA_WAIT_MS", 2500);
const MAX_PENDING_AUDIO_CHUNKS = 40;
const POST_THINKING_COOLDOWN_MS = 250;
// Who decides when the shopper starts and stops talking: this server's own speech detector (default), or Gemini Live's voice
// detection (VOICE_GEMINI_VAD=1). Gemini's sometimes never noticed clear speech in a live test, so nothing was transcribed.
const GEMINI_MANUAL_ACTIVITY = process.env.VOICE_GEMINI_VAD !== "1";

// 100ms of 16kHz 16-bit mono PCM silence (3200 zero bytes).
const SILENCE_PCM_BASE64 = Buffer.alloc(3200, 0).toString("base64");

// Transcripts that are not the shopper talking (see transcriptFilter.js): no word lists.
const transcriptFilter = createTranscriptFilter();

export function looksLikeEcho(transcript, lastAnswer, answeredAt) {
  return isLikelyEcho(transcript, lastAnswer, answeredAt);
}

export function assembleTranscriptChunk(pendingText, cleanChunk, meta = {}) {
  const clean = String(cleanChunk || "").trim();
  if (!clean) return pendingText;
  if (!pendingText) return clean;

  if (clean.length > pendingText.length && clean.startsWith(pendingText)) {
    return clean;
  }

  if (
    meta?.hasLeadingSpace === false &&
    // Devanagari includes combining vowel signs on purpose: a word split mid-syllable is joined back
    // eslint-disable-next-line no-misleading-character-class
    /^[a-z\u0900-\u097f]/i.test(clean) &&
    // eslint-disable-next-line no-misleading-character-class
    /[a-z\u0900-\u097f]$/i.test(pendingText) &&
    clean.length <= 5 &&
    !clean.includes(" ")
  ) {
    return `${pendingText}${clean}`.slice(-2000);
  }

  return `${pendingText} ${clean}`.replace(/\s+/g, " ").trim().slice(-2000);
}

const voiceGovernor = createSharedVoiceGovernor(createVoiceGovernor(), { Model: VoiceSession, connected: () => mongoose.connection?.readyState === 1 });
gauge("voice_sessions_active", "Voice calls in progress on this instance", () => voiceGovernor.active);

wss.on("connection", (socket, request) => {
  let shop = null;
  let voiceClaims = null;

  // set by verifyClient during the handshake
  voiceClaims = request.voiceClaims || null;
  shop = voiceClaims?.shop || null;

  if (!shop) {
    console.log("WebSocket connection rejected: missing or invalid voice token");
    socket.close(1008, "Unauthorized");
    return;
  }

  // taken during the handshake (counted across instances)
  const slot = request.voiceSlot || { ok: false, reason: "server_busy" };
  request.voiceSlotClaimed = true;
  if (!slot.ok) {
    console.warn(`WebSocket refused (${slot.reason}) for ${shop}: ${voiceGovernor.activeFor(shop)} of this store, ${voiceGovernor.active} in total`);
    inc("voice_sessions_refused_total", { reason: slot.reason }, 1, "Voice calls refused because the limits were full");
    try {
      socket.send(JSON.stringify({ type: "error", code: "voice_busy", message: "Voice is busy right now. Please try again in a minute, or keep chatting by text." }));
    } catch { /* the browser already left */ }
    socket.close(1013, "Busy");
    return;
  }
  const watch = voiceGovernor.watch();
  // how much the shopper really spoke lately, to tell speech from words "heard" in silence
  const speech = createSpeechActivity();

  console.log("Browser WebSocket connected for", shop);

  let session;
  let closed = false;
  let sessionReady = false;
  let history = [];
  let lastAskedQuestion = "";
  let isContinuationTurn = false;
  let voiceCart = null;
  let voiceClientId = resolveClientId({ shop, customerId: verifiedCustomerGid(voiceClaims?.customerId) });
  let voiceCustomerLoggedIn = false;
  let voiceCustomer = null;
  const voiceVerifiedCustomerId = verifiedCustomerGid(voiceClaims?.customerId);
  let runId = 0;
  const voiceSessionId = newVoiceSessionId();
  const voiceStartedAt = Date.now();
  let voiceTurns = 0;
  let voiceEndedBy = "";
  let settleTimer = null;
  let pendingText = "";
  let currentRun = null;
  let ignoreTranscriptsUntil = 0;
  const transcriptWatch = createTranscriptWatchdog();
  // the last Gemini Live events of this connection (no words), sent back when the browser asks ({ type: "diag" }): voice
  // problems can be seen from a test page without the server's console
  const voiceDiag = [];
  const audioCount = { chunks: 0, voiced: 0, tooFast: 0, toGemini: 0 };
  // replayed speech is transcribed seconds after it was said: its words still count as heard (a live test lost every replay to
  // the "no speech in the last few seconds" check)
  let replayHeardUntil = 0;
  const noteDiag = (event) => { voiceDiag.push({ t: Date.now(), ...event }); if (voiceDiag.length > 80) voiceDiag.shift(); };
  // The language the customer explicitly chose (recorded by the AI's set_reply_language tool), or "".
  let languageChoice = "";
  // The assistant's last spoken line (for echo detection); the greeting arrives with the resume history.
  let lastAnswer = "";
  let lastAnswerAt = Date.now();
  const pendingAudio = [];

  const sendJson = (payload) => {
    if (!closed && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  };

  // Ends sessions that run too long or sit silent, so a forgotten tab never holds a paid connection.
  const limitTimer = setInterval(() => {
    const why = watch.expired();
    if (!why || closed) return;
    voiceEndedBy = why;
    sendJson({ type: "error", message: why === "idle" ? "Voice paused because it was quiet for a while. Tap the mic to continue." : "This voice session reached its time limit. Tap the mic to start a new one." });
    closeSession();
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, why);
  }, 15_000);
  limitTimer.unref?.();

  const closeSession = () => {
    if (closed) return;

    closed = true;
    clearInterval(limitTimer);
    slot.release();
    // one record of this voice session (nothing is written when the shopper never spoke); never delays or breaks the close
    recordVoiceSession({ shop, clientId: voiceClientId, sessionId: voiceSessionId, startedAt: voiceStartedAt, turns: voiceTurns, endedBy: voiceEndedBy, customerId: voiceVerifiedCustomerId || "" }).catch((error) => console.warn("[voice] could not record the session:", String(error?.message || error).slice(0, 120)));
    sessionReady = false;
    clearTimeout(settleTimer);
    settleTimer = null;
    pendingText = "";
    currentRun?.abort();

    try {
      session?.close();
    } catch (error) {
      console.error("Gemini session cleanup error:", error.message);
    }
  };

  function sendAudioToGemini(data, voiced = false) {
    if (closed) return;
    session?.sendAudio(data, voiced);
  }

  function flushGeminiVadWithSilence() {
    if (!session || !sessionReady || closed) return;
    // the server marks the turns itself: the turn just ends
    if (GEMINI_MANUAL_ACTIVITY) {
      session.endTurn?.();
      return;
    }
    for (let i = 0; i < 4; i++) {
      sendAudioToGemini(SILENCE_PCM_BASE64);
    }
  }

  async function answerPendingText() {
    clearTimeout(settleTimer);
    settleTimer = null;

    if (currentRun) {
      return;
    }

    // the shopper is still talking (a pause mid-sentence): wait for them, a little at a time
    const waitMore = speech.waitBeforeAnswer({ stillSpeakingMs: STILL_SPEAKING_MS, maxExtraMs: MAX_EXTRA_WAIT_MS });
    if (waitMore > 0 && pendingText.trim()) {
      settleTimer = setTimeout(answerPendingText, waitMore);
      return;
    }
    speech.answered();

    const question = pendingText.trim();
    pendingText = "";
    if (!question || closed) return;

    // each piece was already checked against the audio when it arrived; only the text itself is checked here
    const ignoreWhy = transcriptFilter.reasonToIgnore(question);
    if (ignoreWhy) {
      console.log(`Ignoring transcript (${ignoreWhy}):`, customerText(question));
      return;
    }

    return answerQuestion(question);
  }

  // One spoken (or, with files, attached) question: the agent answers it and the browser plays the answer.
  async function answerQuestion(question, { files = [], note = "" } = {}) {
    if (closed) return;
    const thisRun = ++runId;
    const controller = new AbortController();
    currentRun = controller;
    const replacePreviousUserTurn = isContinuationTurn;
    isContinuationTurn = false;
    lastAskedQuestion = question;

    flushGeminiVadWithSilence();

    log.debug(`voice transcript: ${customerText(question)}`);
    // Files are shown by the browser itself (it already put them in the chat); only words need a transcript line.
    if (!files.length) {
      sendJson({
        type: "transcript",
        text: question,
        runId: thisRun,
        replaceLastUser: replacePreviousUserTurn,
      });
    }

    voiceTurns += 1;
    try {
      const result = await runAgent(note ? `${question}\n\n${note}` : question, shop, history, "ecommerce", {
        signal: controller.signal,
        channel: "voice",
        ...(files.length ? { loggedMessage: question, attachments: files } : {}),
        cart: voiceCart,
        clientId: voiceClientId,
        customerLoggedIn: voiceCustomerLoggedIn,
        customer: voiceCustomer,
        verifiedCustomerId: voiceVerifiedCustomerId,
        // Only a language the shopper explicitly chose is enforced; otherwise the model mirrors them.
        ...resolveTurnLanguage({ message: question, languageChoice }),
      });

      if (closed || thisRun !== runId) {
        console.log("Dropping stale answer for:", customerText(question));
        return;
      }

      log.debug(`voice answer: ${customerText(result.answer)} (products: ${result.products?.length || 0})`);

      if (result.cart && typeof result.cart === "object") {
        voiceCart = result.cart;
      }
      if (result.languageChoice !== undefined && result.languageChoice !== languageChoice) {
        languageChoice = result.languageChoice;
        sendJson({ type: "lang", lang: languageChoice });
      }
      lastAnswer = result.answer;
      lastAnswerAt = Date.now();

      history.push(
        { role: "user", content: question },
        { role: "assistant", content: result.answer }
      );
      history = history.slice(-6);

      pendingText = "";
      clearTimeout(settleTimer);
      settleTimer = null;
      ignoreTranscriptsUntil = Date.now() + POST_THINKING_COOLDOWN_MS;
      // speech from before this answer is settled: it is never replayed into a fresh Gemini connection later
      transcriptWatch.transcript();
      // a fresh Gemini connection while the answer is being spoken: one that went deaf (live test 2026-11-22: after a few turns,
      // clear speech got no transcript at all) never costs the shopper their next question
      if (session && typeof session.refresh === "function") session.refresh();

      sendJson({
        type: "answer",
        text: result.answer,
        ...(isFallbackAnswer(result.answer) ? { fallback: true } : {}),
        products: result.products || [],
        actions: result.actions || [],
        checkout: result.checkout || null,
        runId: thisRun,
      });
    } catch (error) {
      if (error?.name === "AbortError" || thisRun !== runId) return;

      console.error("Agent error:", error.message);
      reportError(error, { scope: "voice", tags: { shop } });
      sendJson({
        type: "error",
        code: "answer_failed",
        message: "Unable to answer right now. Please try again.",
      });
    } finally {
      if (currentRun === controller) {
        currentRun = null;
        ignoreTranscriptsUntil = Date.now() + POST_THINKING_COOLDOWN_MS;
      }
    }
  }

  function handleTranscript(transcript, meta = {}) {
    if (typeof transcript === "string" && transcript.trim()) transcriptWatch.transcript();
    noteDiag({ e: "transcript", len: String(transcript || "").length, interim: Boolean(meta?.interim), done: Boolean(meta?.turnComplete), run: Boolean(currentRun) });
    if (
      closed ||
      socket.readyState !== WebSocket.OPEN ||
      typeof transcript !== "string"
    ) {
      return;
    }

    // Words recognised while the shopper is still talking: shown live in the chat, never answered.
    if (meta?.interim) {
      const live = transcript.trim();
      if (live && !currentRun && Date.now() >= ignoreTranscriptsUntil && !looksLikeEcho(live, lastAnswer, lastAnswerAt)) {
        sendJson({ type: "interim", text: live.slice(0, 2000) });
      }
      return;
    }

    // If the user took a slightly longer pause and continued their sentence while currentRun
    // is still in flight (before the assistant answered), abort the premature run and merge both parts!
    if (currentRun) {
      const contClean = transcript.trim();
      if (
        contClean &&
        contClean.length <= 2000 &&
        !transcriptFilter.reasonToIgnore(contClean, { heardSpeech: speech.heardSpeech() || Date.now() < replayHeardUntil }) &&
        !looksLikeEcho(contClean, lastAnswer, lastAnswerAt)
      ) {
        console.log("Merging continuation speech after pause:", customerText(contClean));
        currentRun.abort();
        currentRun = null;
        isContinuationTurn = true;
        pendingText = assembleTranscriptChunk(lastAskedQuestion, contClean, meta);
        sendJson({ type: "partial", text: pendingText, continued: true });
        clearTimeout(settleTimer);
        settleTimer = setTimeout(answerPendingText, TRANSCRIPT_SETTLE_MS);
      }
      return;
    }

    if (Date.now() < ignoreTranscriptsUntil) {
      if (transcript.trim()) {
        console.log("Ignored during post-answer cooldown:", customerText(transcript.trim()));
      }
      return;
    }

    if (!transcript.trim()) {
      if (meta?.turnComplete && pendingText.trim()) {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(answerPendingText, TURN_COMPLETE_SETTLE_MS);
      }
      return;
    }

    const clean = transcript.trim();

    if (clean.length > 2000) {
      console.warn("Invalid transcript rejected.");
      return;
    }

    const chunkIgnoreWhy = transcriptFilter.reasonToIgnore(clean, { heardSpeech: speech.heardSpeech() || Date.now() < replayHeardUntil });
    if (chunkIgnoreWhy && !(pendingText && chunkIgnoreWhy === "no_speech_heard")) {
      console.log(`Ignoring transcript chunk (${chunkIgnoreWhy}):`, customerText(clean));
      return;
    }

    if (looksLikeEcho(clean, lastAnswer, lastAnswerAt)) {
      console.log("Ignoring echo of the assistant's own voice:", customerText(clean));
      return;
    }

    pendingText = assembleTranscriptChunk(pendingText, clean, meta);

    sendJson({ type: "partial", text: clean });

    clearTimeout(settleTimer);
    settleTimer = setTimeout(answerPendingText, meta?.turnComplete ? TURN_COMPLETE_SETTLE_MS : TRANSCRIPT_SETTLE_MS);
  }

  socket.on("message", async (rawMessage) => {
    if (closed || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      const message = JSON.parse(rawMessage.toString());

      if (
        !message ||
        typeof message !== "object" ||
        Array.isArray(message)
      ) {
        return;
      }

      if (message.type === "interrupt") {
        console.log("Client barge-in during assistant speech");
        ignoreTranscriptsUntil = 0;
        if (currentRun) {
          currentRun.abort();
          currentRun = null;
        }
        return;
      }

      if (message.type === "diag") {
        sendJson({ type: "diag", events: voiceDiag.slice(-80), audio: { ...audioCount } });
        return;
      }

      if (message.type === "resume" || message.type === "sync_history") {
        if (Array.isArray(message.history) && message.history.length > 0) {
          history = sanitizeHistory(message.history);
          const lastAssistant = [...history].reverse().find((item) => item.role === "assistant");
          if (lastAssistant && !lastAnswer) {
            lastAnswer = lastAssistant.content;
            lastAnswerAt = Date.now();
          }
        }
        voiceClientId = nextClientId(voiceClientId, message.clientId);
        if (!voiceVerifiedCustomerId) voiceCustomer = guestCustomer(message.customer) || voiceCustomer;
        return;
      }

      // Photos / PDFs attached during the call: already uploaded by the browser, so only their ids arrive here.
      if (message.type === "attachments") {
        const prepared = await prepareVoiceFiles({ shop, clientId: voiceClientId, ids: message.ids, text: message.text }).catch((error) => {
          console.warn("voice files failed:", error.message);
          return null;
        });
        if (closed) return;
        if (!prepared) {
          sendJson({ type: "files_error", message: "Those files could not be used. Please attach them again." });
          return;
        }
        // answering the files replaces whatever was still being worked out
        clearTimeout(settleTimer);
        settleTimer = null;
        pendingText = "";
        if (currentRun) {
          currentRun.abort();
          currentRun = null;
        }
        void answerQuestion(prepared.question, { files: prepared.files, note: prepared.note });
        return;
      }

      if (message.type === "lang_state") {
        if (isLanguageCode(message.lang) || message.lang === "") languageChoice = message.lang;
        return;
      }

      if (
        message.type === "cart_state" &&
        message.cart &&
        typeof message.cart === "object"
      ) {
        voiceCart = message.cart;
        voiceClientId = nextClientId(voiceClientId, message.clientId);
        if (!voiceVerifiedCustomerId) voiceCustomer = guestCustomer(message.customer) || voiceCustomer;
        return;
      }

      if (message.type !== "audio" || typeof message.data !== "string") {
        return;
      }

      if (
        message.data.length === 0 ||
        message.data.length > 60 * 1024 ||
        message.data.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          message.data
        )
      ) {
        return;
      }

      // a microphone cannot produce audio faster than real time: drop anything beyond that
      audioCount.chunks++;
      if (!watch.audio()) { audioCount.tooFast++; return; }
      const voiced = speech.observe(message.data);
      if (voiced) audioCount.voiced++;
      transcriptWatch.audio(message.data, voiced);
      const replay = transcriptWatch.stuck();
      if (replay && session && typeof session.rotate === "function") {
        console.warn(`[voice] speech got no transcript from Gemini Live; opening a fresh connection and replaying ${replay.length} chunks`);
        session.rotate(replay);
        replayHeardUntil = Date.now() + 12000;
        noteDiag({ e: "watchdog_rotate", chunks: replay.length });
      }

      if (!session || !sessionReady) {
        pendingAudio.push({ data: message.data, voiced });
        if (pendingAudio.length > MAX_PENDING_AUDIO_CHUNKS) {
          pendingAudio.shift();
        }
        return;
      }

      audioCount.toGemini++;
      sendAudioToGemini(message.data, voiced);
    } catch (error) {
      console.error("WebSocket message error:", error.message);
    }
  });

  (async () => {
    let newSession;

    try {
      if (!(await isActiveShop(shop))) {
        console.log("WebSocket rejected: shop is not active:", shop);
        socket.close(1008, "Shop is not connected");
        return;
      }

      prewarmStore(shop);
      if (voiceVerifiedCustomerId) {
        const resolved = await resolveShopifyCustomer(shop, voiceClaims.customerId);
        voiceCustomer = resolved.customer || { id: voiceVerifiedCustomerId };
        voiceCustomerLoggedIn = true;
      }

      newSession = createLiveSessionManager({
        connect: connectGeminiLive, onTranscript: handleTranscript, onEvent: noteDiag, manualActivity: GEMINI_MANUAL_ACTIVITY,
        onStatus: message => sendJson({ type: "status", message }),
        onFatal: () => {
          sendJson({ type: "error", message: "Voice connection could not be restored. Tap the mic to reconnect." });
          closeSession();
          if (socket.readyState === WebSocket.OPEN) socket.close(1011, "Voice connection failed");
        },
      });
      session = newSession;
      if (closed || socket.readyState !== WebSocket.OPEN) { session.close(); return; }
      sessionReady = true;
      while (pendingAudio.length) { const early = pendingAudio.shift(); session.sendAudio(early.data, early.voiced); }
      await session.start();
    } catch (error) {
      console.error("Gemini connection failed:", error.message);

      sendJson({ type: "error", message: "Gemini Live connection failed." });
      closeSession();
    }
  })();

  socket.on("close", () => {
    console.log("Browser WebSocket disconnected");
    closeSession();
  });

  socket.on("error", (error) => {
    console.error("Browser WebSocket error:", error.message);
    closeSession();
  });
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err.type === "entity.too.large") {
    return res.status(413).json({
      error: "Request body is too large.",
    });
  }

  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({
      error: "Invalid JSON request body.",
    });
  }

  if (err && err.message === "Origin not allowed by CORS") {
    console.warn("CORS rejected origin:", req.headers?.origin || "unknown");
    return res.status(403).json({
      error: "Origin not allowed by CORS. Store is not connected or is inactive.",
    });
  }

  console.error("Request error:", err.message);
  reportError(err, { scope: "http", tags: { route: req.originalUrl?.split("?")[0]?.slice(0, 80) } });

  return res.status(500).json({
    error: "Internal server error.",
  });
});

// Emails that failed for a passing reason (order confirmations, owner alerts) are sent again here.
function startEmailRetries() {
  const seconds = envCount("EMAIL_RETRY_SECONDS", 60) || 60;
  setInterval(() => void retryKeptEmails().catch((error) => log.warn(`[email] retry sweep failed: ${String(error?.message || error).slice(0, 160)}`)), seconds * 1000).unref();
}

// Webhook work that failed, or that a stopped instance left half done, is retried here.
function startWebhookRetries() {
  const seconds = envCount("WEBHOOK_RETRY_SECONDS", 30) || 30;
  setInterval(() => void webhookQueue().sweep().catch((error) => log.warn(`[webhook] retry sweep failed: ${String(error?.message || error).slice(0, 160)}`)), seconds * 1000).unref();
}

// Files kept in object storage are removed with their records when the store's retention ends.
function startAttachmentSweeper() {
  if (!attachmentStorage()) return;
  const minutes = envCount("ATTACHMENT_SWEEP_MINUTES", 30) || 30;
  const run = () =>
    Promise.all([sweepExpiredObjects({ log }), sweepExpiredRecordings({ log })])
      .then(([files, recordings]) => files + recordings)
      .then((removed) => removed && log.info(`[uploads] removed ${removed} expired file(s) from object storage`))
      .catch((error) => log.warn(`[uploads] sweep failed: ${String(error?.message || error).slice(0, 160)}`));
  setInterval(run, minutes * 60_000).unref();
  void run();
}

export async function startServer() {
  const config = validateEnv();
  for (const warning of config.warnings) log.warn(`config: ${warning}`);
  if (!config.ok) {
    for (const error of config.errors) log.error(`config: ${error}`);
    if (process.env.NODE_ENV === "production") {
      log.error("Refusing to start with an invalid production configuration.");
      process.exit(1);
    }
  }

  process.on("unhandledRejection", (reason) => {
    crashNote("unhandledRejection", reason);
    log.error(`unhandled promise rejection: ${String(reason?.stack || reason).slice(0, 500)}`);
    reportError(reason, { scope: "unhandledRejection" });
  });
  // Both handlers also leave the stack in crash.log (git-ignored): a crash that happens while nobody watches the terminal can still be diagnosed.
  const crashNote = (kind, error) => { try { fs.appendFileSync("crash.log", `${new Date().toISOString()} ${kind} ${String(error?.stack || error).slice(0, 2000)}
`); } catch { /* never let diagnostics crash the server */ } };
  process.on("uncaughtException", (error) => {
    log.error(`uncaught exception: ${String(error?.stack || error).slice(0, 500)}`);
    crashNote("uncaughtException", error);
    reportError(error, { scope: "uncaughtException" });
    alert("crash", `The server crashed and is restarting: ${String(error?.message || error).slice(0, 200)}`);
    shutdownState.shutdown?.("uncaughtException");
  });

  try {
    await connectDB();

    server.listen(PORT, () => {
      log.info(`Server running at http://localhost:${PORT}`);
      log.info(`Rate limits: chat ${process.env.CHAT_RATE_LIMIT || 30}/${Math.round((Number(process.env.CHAT_RATE_WINDOW_MS) || 60000) / 1000)}s per shopper, shop ${process.env.SHOP_AI_RATE_LIMIT_PER_MINUTE || 240}/min, TRUST_PROXY_HOPS=${process.env.TRUST_PROXY_HOPS ?? 1}`);
      log.info("WebSocket server ready");
    });
    // Reports in the log whether Gmail accepts the login (does not hold up the start).
    void verifyEmailTransport({ log });
    startAttachmentSweeper();
    startWebhookRetries();
    startEmailRetries();
    startSupportSweeper();
    shutdownState = installGracefulShutdown({ server, wss: { get clients() { return [...wss.clients, ...supportServer.wss.clients]; } }, mongoose, log });
  } catch (error) {
    log.error(`Failed to connect to MongoDB: ${error.message}`);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT) {
  startServer();
}

export { app, server, wss, supportServer };