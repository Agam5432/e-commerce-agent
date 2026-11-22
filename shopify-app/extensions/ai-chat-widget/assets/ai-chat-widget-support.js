// Talking to a person from the chat: ask to save the call (or not), connect an audio call (WebRTC, audio only),
// and, when nobody is free, try again or book a callback. Everything here is driven by the server: this file never
// decides that a person is free or that a call is connected, it only shows what the server says.
//
// It sits next to ai-chat-widget.js and talks to it through two things the main file provides:
//   root.__aiCommerceBridge       the pieces of the chat it needs (messages, client id, helpers)
//   "ai-commerce:human-support"   fired when the AI says the shopper wants a person (detail = the action)
//   "ai-commerce:call-summary"    fired for the line a finished call leaves in the chat (detail = { item, bubble })
(() => {
  const PROXY = "/apps/ai-agent/support";

  const TEXT = {
    en: {
      asking: "I'm connecting you with our team. Meanwhile: should we record this call and keep it in your chat?",
      sayYesNo: "Tap a button, or just say “yes” or “no”.",
      listening: "Listening… say “yes” or “no”.",
      heardYes: "Heard “yes”.",
      heardNo: "Heard “no”.",
      autoNo: "No answer yet: we continue without a recording in {n} s.",
      noSaveTimeout: "No recording (no answer)",
      askingNote: "Saving is optional. You get the same help either way, and you can stop the recording at any time.",
      yesSave: "Yes, save recording",
      noSave: "No, continue without recording",
      micAsk: "Allow your microphone so we can talk. Your camera is never used.",
      micDenied: "We could not use your microphone, so we cannot start an audio call.",
      orChat: "You can keep chatting here.",
      orChatOrCallback: "You can keep chatting here or book a callback instead.",
      noMicApi: "Audio calls need a secure connection and a browser that supports them.",
      connectingTitle: "Please wait, we're connecting you",
      connectingSub: "Finding an available support representative...",
      s_checking: "Checking availability",
      s_waiting: "Waiting for a representative",
      s_connecting: "Connecting",
      s_ringing: "Ringing",
      s_connected: "Connected",
      s_reconnecting: "Reconnecting",
      s_ended: "Call ended",
      s_failed: "Could not connect",
      cancel: "Cancel",
      cancelled: "Call request cancelled.",
      withRep: "With {name}",
      repDefault: "Support Representative",
      mute: "Mute",
      unmute: "Unmute",
      muted: "Microphone off",
      speakerOff: "Sound off",
      speakerOn: "Sound on",
      end: "End call",
      recordingOn: "Recording",
      recordingStopped: "Recording stopped",
      stopRecording: "Stop recording",
      unavailable: "I'm sorry, our support team is currently assisting other customers, so no representative is available right now. I'd be happy to help you try connecting again in a little while, or you can schedule a callback at a convenient time. Our team will contact you at your selected time.",
      unavailableBusyNoCallback: "I'm sorry, our support team is currently assisting other customers, so no representative is available right now. I'd be happy to help you try connecting again in a little while.",
      unavailableNeutral: "No representative is available at the moment. You can try connecting again in a little while, or schedule a callback at a convenient time.",
      unavailableNoCallback: "No representative is available at the moment. You can try connecting again in a little while.",
      retry: "Try connecting again",
      keepChatting: "Keep chatting here",
      callback: "Schedule a callback",
      stillNone: "Still nobody is free right now.",
      unanswered: "Nobody was able to pick up this time.",
      pickDay: "Pick a day",
      pickTime: "Pick a time",
      timesIn: "Times are shown in {tz}.",
      noSlots: "There are no callback times open right now. Please try again later.",
      yourDetails: "Where should we call you?",
      name: "Your name",
      phone: "Phone number",
      email: "Email",
      confirmCb: "Confirm callback",
      cbBooked: "Your callback request is in for {when}. The team will confirm the time by email.",
      cbYours: "Your callback is booked.",
      cbRequestedTitle: "Your callback request is in.",
      cbOverdue: "The time of your callback has passed. Our team will contact you, or you can choose a new time.",
      cbMinutes: "{m} minutes",
      cbRef: "Reference {ref}",
      cbStatusConfirmed: "Status: confirmed.",
      cbStatusRequested: "Status: waiting for the team to confirm the time.",
      cbMove: "Change time",
      cbMoveTitle: "Choose a new time for your callback",
      cbConfirmMove: "Move my callback",
      cbMoved: "Your callback was moved.",
      cbChosen: "Selected: {when}",
      cbCancel: "Cancel callback",
      cbSure: "Cancel this callback?",
      cbYesCancel: "Yes, cancel it",
      cbKeep: "Keep it",
      cbCancelled: "Your callback was cancelled. The time is free again.",
      cbCancelledByStore: "Your callback was cancelled by the store. You can book another time.",
      cbBookAgain: "Book another time",
      cbConfirmed: "Your callback is confirmed for {when}. A confirmation is on its way to {email}.",
      cbTaken: "That time was just taken. Please pick another.",
      cbInvalid: "Please check your phone number and email.",
      cbFailed: "We could not book that callback. Please try again.",
      back: "Back",
      endedMsg: "The call has ended. Our chat is still here.",
      failedMsg: "The call could not be connected. You can try again or book a callback.",
      lostMsg: "The connection was lost.",
      audioFailMsg: "The audio could not be connected on your network. You can try again, switch between Wi-Fi and mobile data, or book a callback.",
      closeWarn: "A call is in progress. End it first.",
      recordingSaved: "Recording saved",
      recordingHint: "You agreed to this recording. You can listen to it here in the chat after the call.",
      downloadRecording: "Download",
      playRecording: "Play recording",
      loadingRecording: "Loading...",
      recordingMissing: "The recording is not available.",
      offline: "You seem to be offline. Please check your connection.",
      tryLater: "Something went wrong. Please try again.",
    },
    hi: {
      asking: "Main aapko hamari team se connect kar rahi hoon. Tab tak batayein: kya hum is call ko record karke aapki chat mein rakh dein?",
      sayYesNo: "Button dabayein, ya bas bol dein “haan” ya “nahi”.",
      listening: "Sun rahi hoon… “haan” ya “nahi” bolein.",
      heardYes: "“Haan” suna.",
      heardNo: "“Nahi” suna.",
      autoNo: "Abhi jawab nahi aaya: {n} second me bina recording ke aage badhenge.",
      noSaveTimeout: "Recording nahi (jawab nahi aaya)",
      askingNote: "Save karna zaroori nahi hai. Madad dono tarah milegi, aur aap recording kabhi bhi band kar sakte hain.",
      yesSave: "Haan, recording save karein",
      noSave: "Nahi, bina recording ke jaari rakhein",
      micAsk: "Baat karne ke liye apna microphone allow karein. Aapka camera kabhi use nahi hota.",
      micDenied: "Hum aapka microphone use nahi kar paaye, isliye audio call shuru nahi ho sakti.",
      orChat: "Aap yahin chat karte reh sakte hain.",
      orChatOrCallback: "Aap yahin chat kar sakte hain ya callback book kar sakte hain.",
      noMicApi: "Audio call ke liye secure connection aur supported browser chahiye.",
      connectingTitle: "Kripya rukiye, hum aapko connect kar rahe hain",
      connectingSub: "Available support representative dhoondh rahe hain...",
      s_checking: "Availability check ho rahi hai",
      s_waiting: "Representative ka intezaar",
      s_connecting: "Connect ho raha hai",
      s_ringing: "Ring ho rahi hai",
      s_connected: "Connected",
      s_reconnecting: "Dobara connect ho raha hai",
      s_ended: "Call khatam",
      s_failed: "Connect nahi ho paaya",
      cancel: "Cancel",
      cancelled: "Call request cancel ho gayi.",
      withRep: "{name} ke saath",
      repDefault: "Support Representative",
      mute: "Mute",
      unmute: "Unmute",
      muted: "Microphone band",
      speakerOff: "Awaaz band",
      speakerOn: "Awaaz chalu",
      end: "Call khatam karein",
      recordingOn: "Recording chalu",
      recordingStopped: "Recording band",
      stopRecording: "Recording band karein",
      unavailable: "Maaf kijiye, humari support team abhi dusre customers ki madad kar rahi hai, isliye abhi koi representative available nahi hai. Aap thodi der baad dobara try kar sakte hain, ya apni suvidha ke samay par callback schedule kar sakte hain. Humari team aapke chune hue samay par aapse sampark karegi.",
      unavailableBusyNoCallback: "Maaf kijiye, humari support team abhi dusre customers ki madad kar rahi hai, isliye abhi koi representative available nahi hai. Aap thodi der baad dobara try kar sakte hain.",
      unavailableNeutral: "Abhi koi representative available nahi hai. Aap thodi der baad dobara try kar sakte hain, ya callback schedule kar sakte hain.",
      unavailableNoCallback: "Abhi koi representative available nahi hai. Aap thodi der baad dobara try kar sakte hain.",
      retry: "Dobara connect karein",
      keepChatting: "Yahin chat karte rahein",
      callback: "Callback schedule karein",
      stillNone: "Abhi bhi koi free nahi hai.",
      unanswered: "Is baar koi call nahi utha paaya.",
      pickDay: "Din chuniye",
      pickTime: "Samay chuniye",
      timesIn: "Samay {tz} mein dikhaye gaye hain.",
      noSlots: "Abhi callback ke liye koi samay khula nahi hai. Kripya baad mein try karein.",
      yourDetails: "Hum aapko kahan call karein?",
      name: "Aapka naam",
      phone: "Phone number",
      email: "Email",
      confirmCb: "Callback confirm karein",
      cbBooked: "Aapki callback request {when} ke liye aa gayi hai. Team email par samay confirm karegi.",
      cbYours: "Aapka callback book ho gaya hai.",
      cbRequestedTitle: "Aapki callback request aa gayi hai.",
      cbOverdue: "Aapke callback ka samay nikal gaya hai. Hamari team aapse sampark karegi, ya aap naya samay chun sakte hain.",
      cbMinutes: "{m} minute",
      cbRef: "Reference {ref}",
      cbStatusConfirmed: "Status: confirm ho gaya.",
      cbStatusRequested: "Status: team ke samay confirm karne ka intezaar.",
      cbMove: "Samay badlein",
      cbMoveTitle: "Callback ke liye naya samay chunein",
      cbConfirmMove: "Mera callback badal dein",
      cbMoved: "Aapka callback badal diya gaya hai.",
      cbChosen: "Chuna hua: {when}",
      cbCancel: "Callback cancel karein",
      cbSure: "Is callback ko cancel karein?",
      cbYesCancel: "Haan, cancel karein",
      cbKeep: "Rehne dein",
      cbCancelled: "Aapka callback cancel ho gaya. Wo samay ab phir se khaali hai.",
      cbCancelledByStore: "Store ne aapka callback cancel kar diya hai. Aap naya samay book kar sakte hain.",
      cbBookAgain: "Naya samay book karein",
      cbConfirmed: "Aapka callback {when} ke liye confirm hai. Confirmation {email} par bheja ja raha hai.",
      cbTaken: "Woh samay abhi kisi aur ne le liya. Kripya doosra chuniye.",
      cbInvalid: "Kripya apna phone number aur email check karein.",
      cbFailed: "Callback book nahi ho paaya. Kripya dobara try karein.",
      back: "Wapas",
      endedMsg: "Call khatam ho gayi. Humari chat yahin hai.",
      failedMsg: "Call connect nahi ho paayi. Aap dobara try kar sakte hain ya callback book kar sakte hain.",
      lostMsg: "Connection toot gaya.",
      audioFailMsg: "Aapke network par audio connect nahi ho paayi. Dobara try karein, Wi-Fi aur mobile data badal kar dekhein, ya callback book karein.",
      closeWarn: "Call chal rahi hai. Pehle use khatam karein.",
      recordingSaved: "Recording save ho gayi",
      recordingHint: "Aapne is recording ke liye haan kaha tha. Call ke baad aap ise yahin chat me sun sakte hain.",
      downloadRecording: "Download",
      playRecording: "Recording chalayein",
      loadingRecording: "Load ho raha hai...",
      recordingMissing: "Recording available nahi hai.",
      offline: "Lagta hai aap offline hain. Kripya connection check karein.",
      tryLater: "Kuch gadbad ho gayi. Kripya dobara try karein.",
    },
  };

  function attach(root) {
    const bridge = root.__aiCommerceBridge;
    if (!bridge || root.__aiCommerceSupportReady) return;
    root.__aiCommerceSupportReady = true;
    const { panel, messages } = bridge;
    const t = (key, vars) => {
      const lang = ["hi", "hinglish"].includes(bridge.uiLang?.()) ? "hi" : "en"; // the "hi" texts are written in roman Hinglish
      let text = TEXT[lang][key] ?? TEXT.en[key] ?? key;
      if (vars) for (const k of Object.keys(vars)) text = text.split(`{${k}}`).join(String(vars[k]));
      return text;
    };
    const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const apiBase = () => {
      try { return new URL(bridge.apiUrl); } catch { return null; }
    };

    async function post(path, body) {
      const response = await fetch(`${PROXY}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: bridge.getClientId(), ...(body || {}) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok && !data.status) {
        const error = new Error(data.error || t("tryLater"));
        error.status = response.status;
        throw error;
      }
      return { ok: response.ok, status: response.status, data };
    }

    // ---- one call at a time ---------------------------------------------------------------------------------------
    const call = {
      id: "", ws: null, pc: null, local: null, remoteAudio: null, ice: [], pendingCandidates: [], muted: false, speakerOff: false,
      state: "idle", rep: "", recording: false, startedAt: 0, timer: null, ctx: null, levelTimer: null, ui: null, wantsRecording: false,
    };

    // ---- small UI helpers -------------------------------------------------------------------------------------------
    function botCard(html, className = "") {
      const bubble = document.createElement("div");
      bubble.className = "ai-commerce-chat-message ai-commerce-chat-bot ai-sup-bubble";
      bubble.dataset.support = "1";
      bubble.innerHTML = `<div class="ai-sup-card ${className}">${html}</div>`;
      messages.appendChild(bubble);
      bridge.scrollToBottom?.(true);
      return bubble;
    }
    const removeCards = (selector = "[data-support-step]") => messages.querySelectorAll(selector).forEach((el) => el.remove());

    function bars(n = 24) {
      return `<div class="ai-sup-wave" aria-hidden="true">${Array.from({ length: n }, (_, i) => `<i style="--i:${i}"></i>`).join("")}</div>`;
    }

    // ---- the connecting screen and the in-call bar (docked above the chat, which stays usable) -------------------------
    function mountCallUi() {
      if (call.ui) return call.ui;
      const el = document.createElement("section");
      el.className = "ai-sup-call";
      el.setAttribute("role", "region");
      el.setAttribute("aria-label", "Audio call");
      el.innerHTML = `
        <div class="ai-sup-connecting">
          <div class="ai-sup-art" aria-hidden="true">
            <svg viewBox="0 0 64 64" width="64" height="64" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 36v-4a20 20 0 0 1 40 0v4"/><rect x="8" y="34" width="9" height="16" rx="4"/><rect x="47" y="34" width="9" height="16" rx="4"/><path d="M52 50c0 6-6 8-14 8"/></svg>
            <span class="ai-sup-ring r1"></span><span class="ai-sup-ring r2"></span>
          </div>
          <h4 class="ai-sup-title">${esc(t("connectingTitle"))}</h4>
          <p class="ai-sup-sub">${esc(t("connectingSub"))}</p>
          ${bars(28)}
          <p class="ai-sup-state" role="status" aria-live="polite"></p>
          <button type="button" class="ai-sup-btn ghost" data-act="cancel">${esc(t("cancel"))}</button>
        </div>
        <div class="ai-sup-live" hidden>
          <div class="ai-sup-live-top">
            <div class="ai-sup-who"><span class="ai-sup-dot"></span><strong class="ai-sup-name"></strong></div>
            <span class="ai-sup-timer" aria-label="Call duration">00:00</span>
          </div>
          ${bars(20)}
          <div class="ai-sup-rec" hidden><span class="ai-sup-rec-dot"></span><span class="ai-sup-rec-text"></span><button type="button" class="ai-sup-link" data-act="stop-rec">${esc(t("stopRecording"))}</button></div>
          <div class="ai-sup-controls">
            <button type="button" class="ai-sup-btn round" data-act="mute" aria-pressed="false" aria-label="${esc(t("mute"))}" title="${esc(t("mute"))}"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/><path class="slash" d="M4 4l16 16"/></svg></button>
            <button type="button" class="ai-sup-btn round" data-act="speaker" aria-pressed="false" aria-label="${esc(t("speakerOff"))}" title="${esc(t("speakerOff"))}"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg></button>
            <button type="button" class="ai-sup-btn danger" data-act="end">${esc(t("end"))}</button>
          </div>
        </div>`;
      panel.insertBefore(el, messages);
      panel.classList.add("has-support-call");
      call.ui = el;
      el.addEventListener("click", onCallClick);
      return el;
    }

    function unmountCallUi() {
      call.ui?.remove();
      call.ui = null;
      panel.classList.remove("has-support-call");
    }

    function setState(state, detail = "") {
      call.state = state;
      const line = call.ui?.querySelector(".ai-sup-state");
      const label = { checking: "s_checking", waiting: "s_waiting", connecting: "s_connecting", ringing: "s_ringing", connected: "s_connected", reconnecting: "s_reconnecting", ended: "s_ended", failed: "s_failed" }[state];
      if (line) line.textContent = detail || (label ? t(label) : "");
      if (call.ui) call.ui.dataset.state = state;
    }

    function showLive() {
      const el = mountCallUi();
      el.querySelector(".ai-sup-connecting").hidden = true;
      el.querySelector(".ai-sup-live").hidden = false;
      el.querySelector(".ai-sup-name").textContent = t("withRep", { name: call.rep || t("repDefault") });
      panel.classList.add("is-support-live");
      renderRecording();
      call.startedAt = Date.now();
      clearInterval(call.timer);
      const tick = () => {
        const s = Math.floor((Date.now() - call.startedAt) / 1000);
        el.querySelector(".ai-sup-timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
      };
      tick();
      call.timer = setInterval(tick, 1000);
      // the team's typed replies arrive while the call is on
      clearInterval(call.chatTimer);
      call.chatTimer = setInterval(() => bridge.pollSoon?.(), 3500);
      startLevels();
    }

    function renderRecording() {
      const rec = call.ui?.querySelector(".ai-sup-rec");
      if (!rec) return;
      if (call.recording) {
        rec.hidden = false;
        rec.classList.remove("stopped");
        rec.querySelector(".ai-sup-rec-text").textContent = t("recordingOn");
        rec.title = t("recordingHint");
        let hint = call.ui?.querySelector(".ai-sup-rec-hint");
        if (!hint) {
          hint = document.createElement("p");
          hint.className = "ai-sup-rec-hint";
          rec.insertAdjacentElement("afterend", hint);
        }
        hint.textContent = t("recordingHint");
        hint.hidden = false;
        rec.querySelector("[data-act=stop-rec]").hidden = false;
      } else if (call.recordingWas) {
        rec.hidden = false;
        rec.classList.add("stopped");
        rec.querySelector(".ai-sup-rec-text").textContent = t("recordingStopped");
        const oldHint = call.ui?.querySelector(".ai-sup-rec-hint");
        if (oldHint) oldHint.hidden = true;
        rec.querySelector("[data-act=stop-rec]").hidden = true;
      } else rec.hidden = true;
    }

    // real audio levels drive the waveform (the CSS animation is only the fallback)
    function startLevels() {
      stopLevels();
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx || !call.remoteStream) return;
        call.ctx = new Ctx();
        const analyser = call.ctx.createAnalyser();
        analyser.fftSize = 64;
        call.ctx.createMediaStreamSource(call.remoteStream).connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const live = call.ui?.querySelector(".ai-sup-live .ai-sup-wave");
        if (!live) return;
        live.classList.add("driven");
        const items = [...live.children];
        call.levelTimer = setInterval(() => {
          analyser.getByteFrequencyData(data);
          items.forEach((bar, i) => {
            const v = data[Math.min(data.length - 1, Math.floor((i / items.length) * data.length))] / 255;
            bar.style.setProperty("--h", String(Math.max(0.12, v).toFixed(2)));
          });
        }, 90);
      } catch { /* the animated bars stay */ }
    }
    function stopLevels() {
      clearInterval(call.levelTimer);
      call.levelTimer = null;
      try { call.ctx?.close(); } catch { /* already closed */ }
      call.ctx = null;
    }

    // ---- WebRTC --------------------------------------------------------------------------------------------------------
    function sendWs(payload) {
      try { if (call.ws?.readyState === 1) call.ws.send(JSON.stringify(payload)); } catch { /* the close handler cleans up */ }
    }

    function createPeer() {
      const pc = new RTCPeerConnection({ iceServers: call.ice.length ? call.ice : [{ urls: "stun:stun.l.google.com:19302" }] });
      call.pc = pc;
      call.pendingCandidates = [];
      call.kinds = { local: new Set(), remote: new Set() };
      // Without a relay (TURN) two phones or networks often cannot reach each other: the call then sits on
      // "connecting" in silence until the browser gives up. Say so after a short wait instead.
      clearTimeout(call.connectTimer);
      call.connectTimer = setTimeout(() => {
        if (call.pc !== pc || pc.connectionState === "connected") return;
        console.warn("[support] the audio did not connect:", pc.iceConnectionState, pc.connectionState);
        sendWs({ type: "hangup", callId: call.id, reason: `audio timeout (shopper: ${[...call.kinds.local].join(",") || "nothing"}; team: ${[...call.kinds.remote].join(",") || "nothing"}; ice ${pc.iceConnectionState})` });
        finishCall("failed", t("audioFailMsg"));
      }, 25000);
      call.local.getAudioTracks().forEach((track) => pc.addTrack(track, call.local));
      pc.onicecandidate = (e) => { if (e.candidate) { call.kinds.local.add((/ typ (w+)/.exec(e.candidate.candidate) || [])[1] || "unknown"); sendWs({ type: "signal", callId: call.id, kind: "candidate", data: e.candidate }); } };
      pc.ontrack = (e) => {
        call.remoteStream = e.streams[0] || new MediaStream([e.track]);
        if (!call.remoteAudio) {
          call.remoteAudio = document.createElement("audio");
          call.remoteAudio.autoplay = true;
          call.remoteAudio.setAttribute("playsinline", "");
          call.remoteAudio.style.display = "none";
          root.appendChild(call.remoteAudio);
        }
        call.remoteAudio.srcObject = call.remoteStream;
        call.remoteAudio.muted = call.speakerOff;
        call.remoteAudio.play?.().catch(() => {});
      };
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === "connected") { clearTimeout(call.connectTimer); sendWs({ type: "connected", callId: call.id }); }
        else if (s === "disconnected" && call.state === "connected") setState("reconnecting");
        else if (s === "failed") { sendWs({ type: "hangup", callId: call.id, reason: `audio failed (shopper: ${[...call.kinds.local].join(",") || "nothing"}; team: ${[...call.kinds.remote].join(",") || "nothing"})` }); finishCall("failed"); }
      };
      return pc;
    }

    async function startOffer() {
      const pc = createPeer();
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
      await pc.setLocalDescription(offer);
      sendWs({ type: "signal", callId: call.id, kind: "offer", data: pc.localDescription });
      setState("connecting");
    }

    async function onSignal(msg) {
      const pc = call.pc;
      if (!pc) return;
      try {
        if (msg.kind === "answer") {
          await pc.setRemoteDescription(msg.data);
          for (const c of call.pendingCandidates.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        } else if (msg.kind === "candidate") {
          call.kinds?.remote.add((/ typ (w+)/.exec(msg.data?.candidate || "") || [])[1] || "unknown");
          if (pc.remoteDescription) await pc.addIceCandidate(msg.data).catch(() => {});
          else call.pendingCandidates.push(msg.data);
        }
      } catch { /* a bad candidate never ends the call */ }
    }

    function wsAddress() {
      const base = apiBase();
      if (!base) return "";
      return `${base.protocol === "https:" ? "wss" : "ws"}://${base.host}/support-ws`;
    }

    function openSocket(token) {
      const address = wsAddress();
      if (!address) return finishCall("failed", t("tryLater"));
      const ws = new WebSocket(address, ["orbi.support.v1", `orbi.token.${token}`]);
      call.ws = ws;
      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        onServer(msg).catch(() => {});
      };
      ws.onclose = () => {
        if (call.ws !== ws) return;
        if (["requested", "waiting", "connecting", "connected", "ringing", "reconnecting"].includes(call.state)) {
          // the server gives a short grace for a network blip; try to come back once
          if (!call.reconnected && call.id) {
            call.reconnected = true;
            setState("reconnecting");
            post("/token", { callId: call.id }).then(({ data }) => data.token && openSocket(data.token)).catch(() => finishCall("failed", t("lostMsg")));
          } else finishCall("failed", t("lostMsg"));
        }
      };
    }

    async function onServer(msg) {
      switch (msg.type) {
        case "ready":
          call.ice = msg.ice || [];
          setState(msg.call?.status === "requested" ? "waiting" : call.state);
          break;
        case "accepted":
          call.rep = msg.representative?.name || msg.call?.representative?.name || "";
          if (msg.call?.recording?.consent) { call.recording = true; call.recordingWas = true; }
          setState("connecting");
          if (!call.pc) await startOffer();
          break;
        case "signal":
          await onSignal(msg);
          break;
        case "connected":
          call.reconnected = false;
          if (msg.call?.representative?.name) call.rep = msg.call.representative.name;
          if (msg.call?.recording?.consent) { call.recording = true; call.recordingWas = true; }
          setState("connected");
          showLive();
          break;
        case "recording_withdrawn":
          call.recording = false;
          renderRecording();
          break;
        case "ended":
          finishCall(msg.call?.status === "ended" ? "ended" : msg.reason === "unanswered" || msg.call?.status === "unanswered" ? "unanswered" : "failed");
          break;
        case "error":
          if (msg.code === "not_found") finishCall("failed", t("tryLater"));
          break;
        default:
      }
    }

    function releaseMedia() {
      stopLevels();
      clearInterval(call.timer);
      call.timer = null;
      clearInterval(call.chatTimer);
      call.chatTimer = null;
      try { call.pc?.close(); } catch { /* already closed */ }
      call.pc = null;
      call.local?.getTracks().forEach((track) => track.stop());
      call.local = null;
      call.remoteStream = null;
      if (call.remoteAudio) { call.remoteAudio.srcObject = null; call.remoteAudio.remove(); call.remoteAudio = null; }
    }

    // `how`: ended | failed | unanswered | cancelled
    function finishCall(how, message = "") {
      if (call.state === "idle") return;
      const id = call.id;
      const ws = call.ws;
      call.ws = null;
      clearTimeout(call.connectTimer);
      try { ws?.close(1000, "done"); } catch { /* already closed */ }
      releaseMedia();
      unmountCallUi();
      panel.classList.remove("is-support-live");
      Object.assign(call, { id: "", state: "idle", rep: "", recording: false, recordingWas: false, pc: null, reconnected: false, muted: false, speakerOff: false, wantsRecording: false });
      removeCards();
      if (how === "ended") botCard(`<p class="ai-sup-p">${esc(t("endedMsg"))}</p>`);
      else if (how === "unanswered") showUnavailable({ afterTry: true });
      else if (how === "failed") showUnavailable({ failed: true, message });
      // the server wrote the call summary into the chat; fetch it now instead of waiting for the next poll
      bridge.pollSoon?.();
      void id;
    }

    // ---- controls -------------------------------------------------------------------------------------------------------
    function onCallClick(event) {
      const btn = event.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === "cancel") cancelRequest();
      else if (act === "end") { sendWs({ type: "hangup", callId: call.id }); finishCall("ended"); }
      else if (act === "mute") {
        call.muted = !call.muted;
        call.local?.getAudioTracks().forEach((track) => { track.enabled = !call.muted; });
        btn.setAttribute("aria-pressed", String(call.muted));
        btn.setAttribute("aria-label", t(call.muted ? "unmute" : "mute"));
        btn.title = t(call.muted ? "unmute" : "mute");
        btn.classList.toggle("on", call.muted);
      } else if (act === "speaker") {
        call.speakerOff = !call.speakerOff;
        if (call.remoteAudio) call.remoteAudio.muted = call.speakerOff;
        btn.setAttribute("aria-pressed", String(call.speakerOff));
        btn.setAttribute("aria-label", t(call.speakerOff ? "speakerOn" : "speakerOff"));
        btn.classList.toggle("on", call.speakerOff);
      } else if (act === "stop-rec") {
        sendWs({ type: "withdraw_recording", callId: call.id });
        call.recording = false;
        renderRecording();
      }
    }

    async function cancelRequest() {
      const id = call.id;
      try { if (id) await post("/cancel", { callId: id }); } catch { /* the server also closes it when the socket goes */ }
      finishCall("cancelled");
      botCard(`<p class="ai-sup-p">${esc(t("cancelled"))}</p>`);
    }

    // ---- the steps a shopper goes through --------------------------------------------------------------------------------
    let lastOffer = null;
    let lastConsent = false;
    let busy = false;

    function startFlow(action) {
      if (call.state !== "idle") return;
      lastOffer = action || lastOffer || {};
      removeCards();
      if (lastOffer.recordingAvailable) askConsent();
      else beginCall(false);
    }

    // What a shopper says for yes and no: English, Hinglish and Hindi. "no" is checked first ("nahi karo" is a no).
    const SAYS_NO = /(?:^|\s)(?:no|nope|nah|nahi|nahin|nai|na|mat|don't|dont|not)(?:\s|$)|नहीं|नही|ना(?:\s|$)|मत/i;
    const SAYS_YES = /(?:^|\s)(?:yes|yeah|yep|yup|sure|ok|okay|record|please|haan|han|haa|ha|ji|jee|kar do|karo|kardo|theek hai|thik hai)(?:\s|$)|हाँ|हां|जी|ठीक|कर दो|करो/i;
    const heardChoice = (text) => { const v = String(text || "").toLowerCase().trim(); return SAYS_NO.test(v) ? "no" : SAYS_YES.test(v) ? "yes" : ""; };
    const CONSENT_WAIT_S = 15;

    function askConsent() {
      const bubble = botCard(`
        <p class="ai-sup-p">${esc(t("asking"))}</p>
        <p class="ai-sup-note">${esc(t("askingNote"))}</p>
        <div class="ai-sup-actions"><button type="button" class="ai-sup-btn primary" data-choice="yes">${esc(t("yesSave"))}</button><button type="button" class="ai-sup-btn ghost" data-choice="no">${esc(t("noSave"))}</button></div>
        <p class="ai-sup-note ai-sup-hint" data-hint>${esc(t("sayYesNo"))}</p>`);
      bubble.dataset.supportStep = "consent";
      const hint = bubble.querySelector("[data-hint]");
      let decided = false;
      let recognition = null;
      let waited = 0;
      let timer = null;

      const stopListening = () => { try { recognition?.abort(); } catch { /* already stopped */ } recognition = null; };
      const decide = (yes, label = "") => {
        if (decided) return;
        decided = true;
        clearInterval(timer);
        stopListening();
        bubble.querySelectorAll("button").forEach((x) => { x.disabled = true; });
        bubble.querySelector(".ai-sup-actions").innerHTML = `<span class="ai-sup-chosen">${esc(label || t(yes ? "yesSave" : "noSave"))}</span>`;
        hint.remove();
        // the shopper has answered (or the time ran out): now the call is connected
        beginCall(yes);
      };
      bubble.addEventListener("click", (e) => {
        const b = e.target.closest("[data-choice]");
        if (b) decide(b.dataset.choice === "yes");
      });

      // speaking the answer: where the browser can listen, the shopper can just say it
      const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (Recognition) {
        try {
          recognition = new Recognition();
          recognition.lang = bridge.uiLang?.() === "hi" ? "hi-IN" : "en-IN";
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.onresult = (event) => {
            for (let i = event.resultIndex; i < event.results.length; i += 1) {
              const choice = heardChoice(event.results[i][0]?.transcript);
              if (choice) {
                hint.textContent = t(choice === "yes" ? "heardYes" : "heardNo");
                return decide(choice === "yes");
              }
            }
          };
          recognition.onstart = () => { if (!decided) hint.textContent = t("listening"); };
          // listening can stop on its own (silence, no permission): the buttons and the countdown still work
          recognition.onerror = () => { if (!decided) hint.textContent = t("sayYesNo"); };
          recognition.start();
        } catch { recognition = null; }
      }

      // not stuck: without an answer the call is connected, without a recording
      timer = setInterval(() => {
        waited += 1;
        const left = CONSENT_WAIT_S - waited;
        if (left <= 0) return decide(false, t("noSaveTimeout"));
        if (left <= 8 && !decided) hint.textContent = t("autoNo", { n: left });
      }, 1000);
    }

    async function beginCall(consent) {
      if (busy || call.state !== "idle") return;
      busy = true;
      bridge.stopVoice?.();
      lastConsent = consent;
      call.wantsRecording = consent;
      try {
        if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection || !window.isSecureContext) {
          botCard(`<p class="ai-sup-p">${esc(t("noMicApi"))} ${esc(t(lastOffer?.callbackAvailable ? "orChatOrCallback" : "orChat"))}</p>`);
          offerAlternatives({ retry: false });
          return;
        }
        if (!navigator.onLine) { botCard(`<p class="ai-sup-p">${esc(t("offline"))}</p>`); return; }
        mountCallUi();
        setState("checking");
        // the microphone is asked for now, so a refusal is known before anyone's phone rings; audio only, never the camera
        try {
          call.local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        } catch {
          unmountCallUi();
          call.state = "idle";
          botCard(`<p class="ai-sup-p">${esc(t("micDenied"))} ${esc(t(lastOffer?.callbackAvailable ? "orChatOrCallback" : "orChat"))}</p>`);
          offerAlternatives({ retry: false });
          return;
        }
        const { data } = await post("/request", { recordingConsent: consent, reason: lastOffer?.reason || "" });
        if (data.status === "requested") {
          call.id = data.call.id;
          call.recording = Boolean(data.call.recording?.consent);
          call.recordingWas = call.recording;
          setState("waiting");
          openSocket(data.token);
          return;
        }
        // nobody free (or live help is off): release the microphone and say so honestly
        releaseMedia();
        unmountCallUi();
        call.state = "idle";
        showUnavailable({ capabilities: data.capabilities, disabled: data.status === "disabled" });
      } catch (error) {
        releaseMedia();
        unmountCallUi();
        call.state = "idle";
        botCard(`<p class="ai-sup-p">${esc(error?.message || t("tryLater"))}</p>`);
        offerAlternatives({ retry: true });
      } finally {
        busy = false;
      }
    }

    function showUnavailable({ capabilities, disabled, failed, afterTry, message } = {}) {
      const caps = capabilities || {};
      const callbackOk = caps.callbackEnabled ?? lastOffer?.callbackAvailable ?? false;
      let text;
      if (failed) text = message || t("failedMsg");
      else if (afterTry) text = t("unanswered");
      else if (disabled) text = callbackOk ? t("unavailableNeutral") : t("unavailableNoCallback");
      else if (caps.allRepresentativesBusy) text = callbackOk ? t("unavailable") : t("unavailableBusyNoCallback");
      else text = callbackOk ? t("unavailableNeutral") : t("unavailableNoCallback");
      offerAlternatives({ text, retry: !disabled, callback: callbackOk });
    }

    function offerAlternatives({ text = "", retry = true, callback = lastOffer?.callbackAvailable } = {}) {
      removeCards("[data-support-step=options]");
      const bubble = botCard(`
        ${text ? `<p class="ai-sup-p">${esc(text)}</p>` : ""}
        <div class="ai-sup-actions">${retry ? `<button type="button" class="ai-sup-btn primary" data-opt="retry">${esc(t("retry"))}</button>` : ""}${callback ? `<button type="button" class="ai-sup-btn ${retry ? "ghost" : "primary"}" data-opt="callback">${esc(t("callback"))}</button>` : ""}<button type="button" class="ai-sup-btn ${retry || callback ? "ghost" : "primary"}" data-opt="chat">${esc(t("keepChatting"))}</button></div>`);
      bubble.dataset.supportStep = "options";
      bubble.addEventListener("click", (e) => {
        const b = e.target.closest("[data-opt]");
        if (!b) return;
        bubble.querySelectorAll("button").forEach((x) => { x.disabled = true; });
        if (b.dataset.opt === "chat") {
          // the text chat is always there: the shopper is put straight back in the message box
          bubble.querySelector(".ai-sup-actions")?.remove();
          const box = panel.querySelector(".ai-commerce-chat-input, textarea, input[type=text]");
          try { box?.focus(); } catch {}
          return;
        }
        if (b.dataset.opt === "retry") {
          // asking again re-checks the team; a request that is still open is the same one (no duplicates)
          bubble.remove();
          beginCall(lastConsent);
        } else openCallback();
      });
    }

    // ---- the callback the shopper has: always read from the store's database, never from what this page remembers ------------
    const whenLabel = (iso, tz) => {
      try { return new Intl.DateTimeFormat(undefined, { timeZone: tz || undefined, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }).format(new Date(iso)); } catch { return String(iso); }
    };

    /** The card of a booked callback: the real date, time, zone and status, with the ways to change or cancel it. */
    function showCallbackStatus(cb, { note = "" } = {}) {
      removeCards("[data-support-step=callback-status]");
      removeCards("[data-support-step=callback]");
      const title = cb.overdue ? t("cbOverdue") : cb.confirmed ? t("cbYours") : t("cbRequestedTitle");
      const bubble = botCard(`
        ${note ? `<p class="ai-sup-note">${esc(note)}</p>` : ""}
        <p class="ai-sup-h">${esc(title)}</p>
        <p class="ai-sup-p"><strong>${esc(whenLabel(cb.startAt, cb.timezone))}</strong></p>
        <p class="ai-sup-note">${esc(t("timesIn", { tz: cb.timezone }))} · ${esc(t("cbMinutes", { m: cb.callMinutes }))} · ${esc(t("cbRef", { ref: cb.reference }))}</p>
        <p class="ai-sup-note">${esc(cb.confirmed ? t("cbStatusConfirmed") : t("cbStatusRequested"))}</p>
        <div class="ai-sup-actions"><button type="button" class="ai-sup-btn ghost" data-cb-move>${esc(t("cbMove"))}</button><button type="button" class="ai-sup-btn ghost" data-cb-cancel>${esc(t("cbCancel"))}</button></div>
        <p class="ai-sup-err" role="alert" hidden></p>`);
      bubble.dataset.supportStep = "callback-status";
      bubble.dataset.bookingId = cb.id;
      const err = bubble.querySelector(".ai-sup-err");
      bubble.addEventListener("click", async (e) => {
        if (e.target.closest("[data-cb-move]")) return openCallback({ reschedule: cb });
        if (e.target.closest("[data-cb-cancel]")) {
          bubble.querySelector(".ai-sup-actions").innerHTML = `<span class="ai-sup-note">${esc(t("cbSure"))}</span> <button type="button" class="ai-sup-btn primary" data-cb-yes>${esc(t("cbYesCancel"))}</button><button type="button" class="ai-sup-btn ghost" data-cb-no>${esc(t("cbKeep"))}</button>`;
          return;
        }
        if (e.target.closest("[data-cb-no]")) return restoreCallback();
        if (!e.target.closest("[data-cb-yes]")) return;
        e.target.closest("button").disabled = true;
        try {
          const { ok, data } = await post("/callback/cancel", { bookingId: cb.id });
          if (ok && data.status === "cancelled") {
            removeCards("[data-support-step=callback-status]");
            const done = botCard(`<p class="ai-sup-p">${esc(t("cbCancelled"))}</p><div class="ai-sup-actions"><button type="button" class="ai-sup-btn primary" data-cb-again>${esc(t("cbBookAgain"))}</button></div>`);
            done.dataset.supportStep = "callback-status";
            done.querySelector("[data-cb-again]").addEventListener("click", () => openCallback());
            bridge.pollSoon?.();
            return;
          }
          // it was already closed elsewhere (the store cancelled it): show what is true now
          if (data.status === "wrong_state" || data.status === "not_found") return restoreCallback();
          err.hidden = false;
          err.textContent = data.error || t("cbFailed");
        } catch (error) {
          err.hidden = false;
          err.textContent = error.message || t("cbFailed");
        }
        restoreCallback();
      });
      return bubble;
    }

    let restoring = false;
    /** Asks the store what callback this chat has and shows exactly that. Run on load, on opening the chat and on coming back to the tab. */
    async function restoreCallback() {
      if (restoring || call.state !== "idle") return;
      restoring = true;
      try {
        const { data } = await post("/status", {});
        const shown = messages.querySelector("[data-support-step=callback-status]");
        const same = shown && data.callback && shown.dataset.bookingId === data.callback.id && !shown.querySelector("[data-cb-yes]");
        if (data.callback) {
          if (!same && !messages.querySelector("[data-support-step=callback] [data-day], [data-support-step=callback] [data-slot]")) showCallbackStatus(data.callback);
        } else if (shown && shown.dataset.bookingId) {
          // a callback this page showed is gone (the store cancelled it, or it was done): do not leave "booked" on the screen
          shown.remove();
          if (data.previousCallback?.status === "cancelled") {
            const gone = botCard(`<p class="ai-sup-p">${esc(t("cbCancelledByStore"))}</p>`);
            gone.dataset.supportStep = "callback-status";
          }
        }
      } catch { /* the chat works without it; the next try shows it */ } finally { restoring = false; }
    }

    // ---- callback booking (the store's own booking rules; the server re-checks the time) -----------------------------------
    async function openCallback({ reschedule = null } = {}) {
      removeCards("[data-support-step=callback]");
      removeCards("[data-support-step=callback-status]");
      const bubble = botCard(`<p class="ai-sup-p">${esc(t("loadingRecording"))}</p>`);
      bubble.dataset.supportStep = "callback";
      let slots;
      try {
        slots = (await post("/slots", {})).data;
      } catch (error) {
        bubble.querySelector(".ai-sup-card").innerHTML = `<p class="ai-sup-p">${esc(error.message || t("tryLater"))}</p>`;
        return;
      }
      if (!slots.enabled || !slots.days?.length) {
        bubble.querySelector(".ai-sup-card").innerHTML = `<p class="ai-sup-p">${esc(t("noSlots"))}</p>`;
        return;
      }
      const state = { day: slots.days[0].date, slot: "" };
      const dayLabel = (iso) => new Intl.DateTimeFormat(undefined, { timeZone: slots.timezone, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
      const timeLabel = (iso) => new Intl.DateTimeFormat(undefined, { timeZone: slots.timezone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
      const dateOnly = (iso) => iso;
      const draw = () => {
        const day = slots.days.find((d) => d.date === state.day) || slots.days[0];
        const card = bubble.querySelector(".ai-sup-card");
        const chosen = state.slot ? `<p class="ai-sup-p">${esc(t("cbChosen", { when: whenLabel(state.slot, slots.timezone) }))}</p><p class="ai-sup-note">${esc(t("timesIn", { tz: slots.timezone }))} · ${esc(t("cbMinutes", { m: slots.callMinutes }))}</p>` : "";
        const details = reschedule ? `
          <p class="ai-sup-err" role="alert" hidden></p>
          <button type="button" class="ai-sup-btn primary" data-confirm>${esc(t("cbConfirmMove"))}</button>` : `
          <p class="ai-sup-h">${esc(t("yourDetails"))}</p>
          <div class="ai-sup-form">
            <input class="ai-sup-input" data-f="name" autocomplete="name" placeholder="${esc(t("name"))}" value="${esc(state.name ?? root.dataset.customerName ?? "")}" />
            <input class="ai-sup-input" data-f="phone" autocomplete="tel" inputmode="tel" placeholder="${esc(t("phone"))}" value="${esc(state.phone ?? root.dataset.customerPhone ?? "")}" />
            <input class="ai-sup-input" data-f="email" type="email" autocomplete="email" placeholder="${esc(t("email"))}" value="${esc(state.email ?? root.dataset.customerEmail ?? "")}" />
            <p class="ai-sup-err" role="alert" hidden></p>
            <button type="button" class="ai-sup-btn primary" data-confirm>${esc(t("confirmCb"))}</button>
          </div>`;
        card.innerHTML = `
          ${reschedule ? `<p class="ai-sup-h">${esc(t("cbMoveTitle"))}</p>` : ""}
          <p class="ai-sup-h">${esc(t("pickDay"))}</p>
          <div class="ai-sup-chips" role="tablist">${slots.days.map((d) => `<button type="button" role="tab" aria-selected="${d.date === day.date}" class="ai-sup-chip${d.date === day.date ? " on" : ""}" data-day="${esc(d.date)}">${esc(dayLabel(d.slots[0].start))}</button>`).join("")}</div>
          <p class="ai-sup-h">${esc(t("pickTime"))}</p>
          <div class="ai-sup-chips">${day.slots.map((s) => `<button type="button" class="ai-sup-chip${s.start === state.slot ? " on" : ""}" data-slot="${esc(s.start)}">${esc(timeLabel(s.start))}</button>`).join("")}</div>
          <p class="ai-sup-note">${esc(t("timesIn", { tz: slots.timezone }))}</p>
          ${state.slot ? chosen + details : ""}
          ${reschedule ? `<div class="ai-sup-actions"><button type="button" class="ai-sup-btn ghost" data-cb-back>${esc(t("cbKeep"))}</button></div>` : ""}`;
        bridge.scrollToBottom?.(true);
      };
      void dateOnly;
      bubble.addEventListener("input", (e) => { const f = e.target.dataset?.f; if (f) state[f] = e.target.value; });
      bubble.addEventListener("click", async (e) => {
        const dayBtn = e.target.closest("[data-day]");
        const slotBtn = e.target.closest("[data-slot]");
        if (e.target.closest("[data-cb-back]")) return restoreCallback();
        if (dayBtn) { state.day = dayBtn.dataset.day; state.slot = ""; return draw(); }
        if (slotBtn) { state.slot = slotBtn.dataset.slot; return draw(); }
        if (!e.target.closest("[data-confirm]")) return;
        const err = bubble.querySelector(".ai-sup-err");
        const button = bubble.querySelector("[data-confirm]");
        const val = (f) => (bubble.querySelector(`[data-f=${f}]`)?.value || "").trim();
        if (!reschedule && (!val("name") || !val("phone") || !val("email"))) { err.hidden = false; err.textContent = t("cbInvalid"); return; }
        // one click is one request: the button stays off until the store has answered
        if (button.disabled) return;
        button.disabled = true;
        err.hidden = true;
        try {
          const { ok, data } = reschedule
            ? await post("/callback/reschedule", { bookingId: reschedule.id, slotStart: state.slot })
            : await post("/callback", { slotStart: state.slot, name: val("name"), phone: val("phone"), email: val("email"), language: bridge.uiLang?.() || "en" });
          if (ok && (data.status === "confirmed" || data.status === "booked") && data.callback) {
            // what the store says it saved, in the store's own words: the same card a reload will show
            showCallbackStatus(data.callback, { note: reschedule ? t("cbMoved") : "" });
            bridge.pollSoon?.();
            return;
          }
          if (data.status === "already_booked" && data.callback) return showCallbackStatus(data.callback);
          if (data.status === "slot_unavailable") {
            state.slot = "";
            slots = (await post("/slots", {})).data;
            draw();
            const again = bubble.querySelector(".ai-sup-card");
            again.insertAdjacentHTML("afterbegin", `<p class="ai-sup-err" role="alert">${esc(t("cbTaken"))}</p>`);
            return;
          }
          err.hidden = false;
          err.textContent = data.status === "invalid" ? t("cbInvalid") : t("cbFailed");
        } catch (error) {
          err.hidden = false;
          err.textContent = error.message || t("cbFailed");
        }
        button.disabled = false;
      });
      draw();
    }

    // ---- the line a finished call leaves in the chat -------------------------------------------------------------------
    root.addEventListener("ai-commerce:call-summary", (event) => {
      const { item, bubble } = event.detail || {};
      if (!item?.call || !bubble) return;
      bubble.classList.add("ai-sup-summary");
      bubble.dataset.callId = item.call.callId;
      if (item.call.recording) {
        const row = document.createElement("div");
        row.className = "ai-sup-rec-row";
        row.innerHTML = `<button type="button" class="ai-sup-btn ghost small" data-play>${esc(t("playRecording"))}</button><span class="ai-sup-note">${esc(t("recordingSaved"))}</span>`;
        bubble.appendChild(row);
        row.querySelector("[data-play]").addEventListener("click", async (e) => {
          const button = e.currentTarget;
          button.disabled = true;
          button.textContent = t("loadingRecording");
          try {
            const response = await fetch(`${PROXY}/recording`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: bridge.getClientId(), callId: item.call.callId }) });
            if (!response.ok) throw new Error("missing");
            const url = URL.createObjectURL(await response.blob());
            const audio = document.createElement("audio");
            audio.controls = true;
            audio.src = url;
            audio.className = "ai-sup-audio";
            const save = document.createElement("a");
            save.className = "ai-sup-link";
            save.href = url;
            save.download = "call-recording.webm";
            save.textContent = t("downloadRecording");
            row.replaceChildren(audio, save);
            audio.play().catch(() => {});
          } catch {
            button.disabled = false;
            button.textContent = t("playRecording");
            row.insertAdjacentHTML("beforeend", `<span class="ai-sup-err">${esc(t("recordingMissing"))}</span>`);
          }
        });
      }
    });

    root.addEventListener("ai-commerce:human-support", (event) => startFlow(event.detail || {}));
    // closing the chat window must not leave a call running unseen
    root.addEventListener("ai-commerce:before-close", (event) => {
      if (call.state !== "idle" && call.state !== "checking") event.preventDefault?.();
    });
    window.addEventListener("pagehide", () => {
      if (call.id) { try { navigator.sendBeacon?.(`${PROXY}/cancel`, new Blob([JSON.stringify({ clientId: bridge.getClientId(), callId: call.id })], { type: "application/json" })); } catch { /* the server drops it after a short grace */ } }
    });
    // The callback is shown from the store's database every time the chat is on screen: a hard refresh, a closed and reopened
    // window and another tab all show the same, true state.
    setTimeout(restoreCallback, 700);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) restoreCallback(); });
    root.querySelector(".ai-commerce-chat-toggle")?.addEventListener("click", () => setTimeout(restoreCallback, 400));
    // a way in that does not depend on the AI: the chat menu can offer it too
    root.__aiCommerceSupport = { start: () => startFlow({ recordingAvailable: lastOffer?.recordingAvailable, callbackAvailable: lastOffer?.callbackAvailable }), state: () => call.state };
  }

  function start() {
    document.querySelectorAll(".ai-commerce-chat-root").forEach((root) => {
      if (root.__aiCommerceBridge) attach(root);
      else root.addEventListener("ai-commerce:bridge", () => attach(root), { once: true });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
