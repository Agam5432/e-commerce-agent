(() => {
  function initChat(root) {
    if (root.dataset.initialized === "true") return;
    root.dataset.initialized = "true";

    const toggle = root.querySelector(".ai-commerce-chat-toggle");
    const panel = root.querySelector(".ai-commerce-chat-panel");
    const close = root.querySelector(".ai-commerce-chat-close");
    const backBtn = root.querySelector(".ai-commerce-chat-back");
    const form = root.querySelector(".ai-commerce-chat-form");
    const input = root.querySelector(".ai-commerce-chat-input");
    const messages = root.querySelector(".ai-commerce-chat-messages");
    const send = root.querySelector(".ai-commerce-chat-send");
    const status = root.querySelector(".ai-commerce-chat-status");

    // The voice panel already shows listening / thinking / speaking, so the status line under it stays
    // hidden for those states (and its space goes back to the chat). It only appears, briefly, for
    // problems the shopper needs to know about. Other code still writes state text into it and reads it.
    let statusAlertTimer = null;
    function showStatusAlert(message) {
      if (!status) return;
      status.textContent = message;
      status.dataset.alert = "1";
      clearTimeout(statusAlertTimer);
      statusAlertTimer = setTimeout(() => {
        delete status.dataset.alert;
      }, 8000);
    }
    const mic = root.querySelector(".ai-commerce-chat-mic");
    const voiceStrip = root.querySelector(".ai-commerce-chat-voice");
    const voiceLabel = root.querySelector(".ai-commerce-chat-voice-label");
    const languageSelect = root.querySelector(".ai-commerce-chat-lang-select");
    const cartCount = root.querySelector(".ai-commerce-chat-cart-count");
    const minimizeBtn = root.querySelector(".ai-commerce-chat-minimize");
    const menuBtn = root.querySelector(".ai-commerce-chat-menu-btn");
    const menuPanel = root.querySelector(".ai-commerce-chat-menu");
    const clearBtn = root.querySelector(".ai-commerce-chat-menu-clear");
    const confirmBox = root.querySelector(".ai-commerce-confirm");
    const confirmNo = root.querySelector(".ai-commerce-confirm-no");
    const confirmYes = root.querySelector(".ai-commerce-confirm-yes");
    const teaser = root.querySelector(".ai-commerce-teaser");
    const teaserText = root.querySelector(".ai-commerce-teaser-text");
    const teaserDots = root.querySelector(".ai-commerce-teaser-dots");
    const teaserClose = root.querySelector(".ai-commerce-teaser-x");
    const unreadBadge = root.querySelector(".ai-commerce-bot-unread");
    const chipsBox = root.querySelector(".ai-commerce-chat-chips");
    const tray = root.querySelector(".ai-commerce-tray");
    const trayFiles = root.querySelector(".ai-commerce-tray-files");
    const trayNote = root.querySelector(".ai-commerce-tray-note");
    const trayClear = root.querySelector(".ai-commerce-tray-clear");
    const attachBtn = root.querySelector(".ai-commerce-chat-attach");
    const fileInput = root.querySelector(".ai-commerce-chat-file");
    const voiceWave = root.querySelector(".ai-commerce-voice-wave");
    const voiceTimer = root.querySelector(".ai-commerce-voice-timer");
    const voiceMicPill = root.querySelector(".ai-commerce-voice-micpill");
    const voiceEnd = root.querySelector(".ai-commerce-voice-end");
    const voiceAttach = root.querySelector(".ai-commerce-voice-attach");
    const cartToast = root.querySelector(".ai-commerce-cart-toast");
    const cartToastText = root.querySelector(".ai-commerce-cart-toast-text");
    const voiceCenterMic = root.querySelector(".ai-commerce-voice-center-mic");
    const voiceCaption = root.querySelector(".ai-commerce-voice-caption");
    const shopName = root.dataset.shopName || "this store";
    const initialWelcomeBanner = root.querySelector(".ai-commerce-welcome-banner");
    const welcomeBannerClone = initialWelcomeBanner ? initialWelcomeBanner.cloneNode(true) : null;
    let toastTimer = null;

    function showCartToast(text) {
      if (!cartToast || !cartToastText) return;
      cartToastText.textContent = text;
      cartToast.hidden = false;
      cartToast.removeAttribute("hidden");
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        cartToast.hidden = true;
      }, 3000);
    }

    function ensureWelcomeBanner() {
      if (!messages || !welcomeBannerClone) return;
      if (!messages.querySelector(".ai-commerce-welcome-banner")) {
        messages.insertBefore(welcomeBannerClone.cloneNode(true), messages.firstChild);
      }
    }

    function formatMsgTime() {
      try {
        return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      } catch {
        return "";
      }
    }

    if (!toggle || !panel || !close || !form || !input || !messages || !send) {
      console.error("AI chat widget: required elements are missing.");
      return;
    }

    const ROBOT_BODY_DATA_URI = "data:image/webp;base64,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";
    const ROBOT_ARM_DATA_URI = "data:image/webp;base64,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";
    const botBodyImg = root.querySelector(".ai-commerce-bot-body-img");
    const botArmImg = root.querySelector(".ai-commerce-bot-arm-img");
    // The robot pictures are inside this file, so the launcher never depends on a separate image file
    // (a missing file, a CDN that has not caught up, a link with a version suffix: none of them can break it).
    if (botBodyImg) botBodyImg.setAttribute("href", ROBOT_BODY_DATA_URI);
    if (botArmImg) botArmImg.setAttribute("href", ROBOT_ARM_DATA_URI);

    // The backend address: the theme block's "Chat backend URL" setting, or, when it is empty, the address the store's
    // app proxy reports (GET /apps/ai-agent/), so a merchant does not have to paste it.
    let apiUrl = String(root.dataset.apiUrl || "").trim();
    let apiUrlLookup = null;
    // Links and pictures that come from store data: only http(s) addresses (or a path on this store) are used, never
    // javascript: or other schemes. A protocol-relative //host/... address becomes https.
    function safeUrl(value) {
      const text = String(value ?? "").trim();
      const absolute = text.startsWith("//") ? `https:${text}` : text;
      return /^https?:\/\//i.test(absolute) || /^\/(?!\/)/.test(absolute) ? absolute : "";
    }
    function ensureApiUrl() {
      if (apiUrl) return Promise.resolve(apiUrl);
      if (!apiUrlLookup) {
        apiUrlLookup = fetch("/apps/ai-agent/", { headers: { Accept: "application/json", "ngrok-skip-browser-warning": "1" } })
          .then((response) => (response.ok ? response.json() : {}))
          .then((data) => {
            try {
              const found = new URL(String(data?.apiUrl || ""));
              if (found.protocol === "https:") apiUrl = found.origin;
            } catch {}
            return apiUrl;
          })
          .catch(() => "")
          .finally(() => { apiUrlLookup = null; });
      }
      return apiUrlLookup;
    }
    try { console.info("[ai-commerce-widget] build 2026-11-14-a"); } catch {}
    const storeDomain = root.dataset.storeDomain;

    let voiceSocket = null;
    let mediaStream = null;
    let audioContext = null;
    let sourceNode = null;
    let processorNode = null;
    let silentGain = null;
    let isVoiceConnecting = false;
    let isVoiceListening = false;
    let voiceSessionReady = false;
    let voiceBuffer = [];
    let voiceBufferLength = 0;
    let isSpeakingResponse = false;
    let isThinking = false;
    let bargeInHits = 0;
    let voiceAnswerEpoch = 0;
    let speakingChunks = 0;
    let echoLevel = 0;
    let suppressVoiceAnswers = false;
    let latestTranscriptRunId = 0;
    // The turn the shopper cut off: whatever of it still arrives (answer, audio) is dropped, never spoken after the interruption.
    let lastAnswerRunId = 0;
    let interruptedRunId = 0;
    const isStaleVoiceRun = (runId) => !runId || runId < latestTranscriptRunId || runId <= interruptedRunId;
    const recentSpeech = [];
    let isMinimized = false;
    let lastAnswerText = "";
    // When the assistant's own voice came back through the microphone: while it speaks, and for a moment after.
    let speechStartedAt = 0;
    let speechEndedAt = 0;
    const ECHO_TAIL_MS = 1500;
    // A browser's text-to-speech heard again by the microphone is never written back exactly as it was said: it is
    // recognised by how much of it is the assistant's own words in the same order (same rule as the server's isLikelyEcho).
    const echoWords = (v) => String(v || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
    function isEchoOfSpeech(text) {
      const spoken = echoWords(lastAnswerText);
      const words = echoWords(text);
      if (!spoken.length || words.length < 3 || /\p{N}/u.test(String(text || ""))) return false;
      const speaking = isSpeakingResponse || Date.now() - speechEndedAt < ECHO_TAIL_MS;
      if (!speaking) return false;
      const set = new Set(spoken);
      const pairs = new Set(spoken.slice(1).map((w, i) => spoken[i] + " " + w));
      const own = words.filter((w) => set.has(w)).length / words.length;
      const heardPairs = words.slice(1).map((w, i) => words[i] + " " + w);
      const ownPairs = heardPairs.length ? heardPairs.filter((x) => pairs.has(x)).length / heardPairs.length : 0;
      return (own >= 0.85 && ownPairs >= 0.5) || (words.length >= 6 && own >= 0.65 && ownPairs >= 0.35);
    }
    // A possible interruption heard by the microphone while the browser's own voice speaks. The assistant keeps talking
    // while the server writes down what was heard: other words than its own stop it, its own words change nothing.
    let bargeCandidateUntil = 0;
    const BARGE_CANDIDATE_MS = 3000;
    const BARGE_CANDIDATE_MAX_MS = 9000;
    let bargeCandidateStartedAt = 0;
    const browserVoiceSpeaking = () => Boolean(activeUtterance) && !serverAudioSource;

    let displayedProducts = [];
    const chatHistory = [];
    let checkoutState = null;
    let clientId = "";
    // The language the customer explicitly chose (recorded by the AI), "" = the AI mirrors them.
    // One "live" user bubble per spoken turn: filled with the words recognised so far, then replaced by
    // the final transcript (shown at once, no typing animation).
    let liveUserBubble = null;
    let liveCommitted = "";
    function showLiveTranscript(text) {
      const value = String(text || "").trim();
      if (!value) return;
      if (!liveUserBubble || !liveUserBubble.isConnected) {
        liveUserBubble = addMessage(value, "user");
        liveUserBubble.classList.add("is-live");
      } else {
        liveUserBubble.textContent = value;
        liveUserBubble.dataset.rawText = value;
      }
      safeScrollMessagesToBottom(true);
    }
    function finishLiveTranscript(finalText) {
      const bubble = liveUserBubble && liveUserBubble.isConnected ? liveUserBubble : null;
      liveUserBubble = null;
      liveCommitted = "";
      if (bubble) {
        bubble.classList.remove("is-live");
        bubble.textContent = finalText;
        bubble.dataset.rawText = finalText;
        try {
          saveChatState();
        } catch {}
        return bubble;
      }
      return addMessage(finalText, "user");
    }
    function dropLiveTranscript() {
      if (liveUserBubble && liveUserBubble.isConnected) liveUserBubble.remove();
      liveUserBubble = null;
      liveCommitted = "";
    }

    let preferredLanguage = "";
    var uiReady = false;
    // The reply language: "" = follow the shopper, "en" = English, "hi" = Hindi. Set from the menu in
    // the header, or by the agent when the shopper agrees to switch (then the menu follows).
    function setPreferredLanguage(code, { fromMenu = false } = {}) {
      const next = ["en", "hi", "hinglish"].includes(code) ? code : "";
      preferredLanguage = next;
      if (languageSelect && languageSelect.value !== next) {
        languageSelect.value = Array.from(languageSelect.options).some((o) => o.value === next) ? next : "";
      }
      if (uiReady) applyUiLang();
      if (!fromMenu) return;
      try {
        saveChatState();
      } catch {}
      try {
        if (voiceSocket && voiceSocket.readyState === WebSocket.OPEN) {
          voiceSocket.send(JSON.stringify({ type: "lang_state", lang: next }));
        }
      } catch {}
    }
    // The opening message is written by the AI (store, customer, time of day). The merchant's
    // greeting from the theme editor is shown only if the AI cannot be reached.
    const MERCHANT_GREETING = String(root.dataset.greeting || "").trim();
    const GREETING_WAIT_MS = 8000; // how long the AI's opening line may take before the store's own greeting is shown
    let openingMessagePromise = null;
    let lastMessageAt = 0;
    let voiceGreetingDone = false;
    let restoringState = false;
    let pageLeaving = false;
    const storageKey = `ai_commerce_chat_${root.dataset.storeDomain || "store"}`;
    let customerLoggedIn = false;
    let storefrontCustomer = null;

    function persistCustomer(cust, loggedIn) {
      try {
        const storeDomain = root.dataset.storeDomain || "store";
        if (cust && loggedIn) {
          localStorage.setItem("ai_commerce_customer_" + storeDomain, JSON.stringify({
            loggedIn: true,
            customer: cust,
            updatedAt: Date.now()
          }));
        } else if (loggedIn === false) {
          localStorage.removeItem("ai_commerce_customer_" + storeDomain);
        }
      } catch {}
    }

    function readStoredCustomer() {
      try {
        const storeDomain = root.dataset.storeDomain || "store";
        const raw = localStorage.getItem("ai_commerce_customer_" + storeDomain);
        if (raw) {
          const parsed = JSON.parse(raw);
          // the shopper's details are kept on this device for a day at most, then forgotten
          if (parsed && Date.now() - Number(parsed.updatedAt || 0) > 24 * 60 * 60 * 1000) {
            localStorage.removeItem("ai_commerce_customer_" + storeDomain);
            return null;
          }
          if (parsed && parsed.loggedIn && parsed.customer) {
            return parsed.customer;
          }
        }
      } catch {}
      return null;
    }

    function initCustomerIdentity() {
      // 1. Check embedded JSON from liquid block
      const jsonEl = root.querySelector(".ai-commerce-customer-json");
      if (jsonEl) {
        try {
          const data = JSON.parse(jsonEl.textContent || "{}");
          if (data && data.loggedIn) {
            customerLoggedIn = true;
            storefrontCustomer = {
              id: data.id || null,
              email: data.email || null,
              name: data.name || (data.firstName ? (data.firstName + " " + (data.lastName || "")).trim() : null),
              phone: data.phone || null,
              defaultAddress: data.defaultAddress || null,
            };
            persistCustomer(storefrontCustomer, true);
            return;
          }
        } catch {}
      }

      // 2. Check root dataset attributes from liquid
      if (root.dataset.customerLoggedIn === "true") {
        customerLoggedIn = true;
        const addr1 = (root.dataset.customerAddress1 || "").trim();
        storefrontCustomer = {
          id: (root.dataset.customerId || "").trim() || null,
          email: (root.dataset.customerEmail || "").trim() || null,
          name: (root.dataset.customerName || "").trim() || null,
          phone: (root.dataset.customerPhone || "").trim() || null,
          defaultAddress: addr1 ? {
            address1: addr1,
            address2: (root.dataset.customerAddress2 || "").trim() || null,
            city: (root.dataset.customerCity || "").trim() || null,
            province: (root.dataset.customerProvince || "").trim() || null,
            zip: (root.dataset.customerZip || "").trim() || null,
            country: (root.dataset.customerCountry || "").trim() || null,
          } : null,
        };
        persistCustomer(storefrontCustomer, true);
        return;
      }

      // 3. Fallback to the details saved on this device, but only while the page still shows a sign of a login.
      // The page says nobody is signed in and no login signal is present: the saved details belong to someone who
      // has left (a shared computer), so they are forgotten instead of being offered to the next shopper.
      const loginSignal = Boolean(window.ShopifyAnalytics?.meta?.page?.customerId || window.__st?.cid || document.querySelector('a[href*="/account/logout"], form[action*="/account/logout"]'));
      if (!loginSignal) { persistCustomer(null, false); return; }
      const stored = readStoredCustomer();
      if (stored) {
        customerLoggedIn = true;
        storefrontCustomer = stored;
      }
    }
    initCustomerIdentity();

    async function syncCustomerSession() {
      try {
        const analyticsCid = window.ShopifyAnalytics?.meta?.page?.customerId || window.__st?.cid;
        const logoutLink = document.querySelector('a[href*="/account/logout"], form[action*="/account/logout"]');
        const appearsLoggedIn = Boolean(customerLoggedIn || analyticsCid || logoutLink);
        if (!appearsLoggedIn) return;

        const res = await fetch("/account", { credentials: "same-origin", headers: { "Accept": "text/html" } });
        if (res.ok && !res.url.includes("/login")) {
          customerLoggedIn = true;
          const html = await res.text();
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, "text/html");

          let name = storefrontCustomer?.name || null;
          const heading = doc.querySelector(".customer__title, .account-header h1, h1, h2");
          if (heading) {
            const hText = heading.textContent.trim();
            const m = hText.match(/(?:welcome|hello|hi)[,\s]+([^!\n\r]+)/i);
            if (m && m[1]) name = m[1].trim();
          }

          let email = storefrontCustomer?.email || null;
          const emailMatch = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
          if (emailMatch) email = emailMatch[0];

          let defaultAddress = storefrontCustomer?.defaultAddress || null;
          if (!defaultAddress || !defaultAddress.address1) {
            try {
              const addrRes = await fetch("/account/addresses", { credentials: "same-origin", headers: { "Accept": "text/html" } });
              if (addrRes.ok) {
                const addrHtml = await addrRes.text();
                const addrDoc = parser.parseFromString(addrHtml, "text/html");
                const defEl = addrDoc.querySelector(".address--default, [data-address-default], .customer-address");
                if (defEl) {
                  const lines = (defEl.innerText || defEl.textContent || "")
                    .split("\n")
                    .map(l => l.trim())
                    .filter(Boolean);
                  if (lines.length >= 2) {
                    defaultAddress = {
                      address1: lines[0],
                      city: lines[1],
                      raw: lines.join(", ")
                    };
                  }
                }
              }
            } catch {}
          }

          storefrontCustomer = {
            id: analyticsCid || storefrontCustomer?.id || null,
            name: name || storefrontCustomer?.name || null,
            email: email || storefrontCustomer?.email || null,
            phone: storefrontCustomer?.phone || null,
            defaultAddress: defaultAddress || storefrontCustomer?.defaultAddress || null,
          };
          persistCustomer(storefrontCustomer, true);
        } else if (res.url.includes("/login")) {
          customerLoggedIn = false;
          storefrontCustomer = null;
          persistCustomer(null, false);
        }
      } catch (e) {
        console.debug("Customer session sync error:", e);
      }
    }
    syncCustomerSession();

    // The client id unlocks this shopper's checkout and order-verification state on the server, so
    // it is generated with the browser's cryptographic random generator (never Math.random/time).
    function newClientId() {
      try {
        if (window.crypto?.randomUUID) return `c_${window.crypto.randomUUID().replace(/-/g, "")}`;
        const bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        return `c_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
      } catch {
        return "";
      }
    }
    // The visitor id lives in a first-party cookie (30 days, renewed every visit), mirrored into localStorage.
    // While the cookie exists the store's agent can look at this visitor's earlier chats; when the shopper clears
    // their cookies the id is gone, so the agent starts fresh (the store keeps its own copy for the owner).
    const CLIENT_ID_KEY = "ai_commerce_client_id";
    const CLIENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
    const COOKIE_SEEN_KEY = "ai_commerce_client_cookie";
    const CLIENT_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
    function readClientCookie() {
      try {
        const match = document.cookie.match(new RegExp("(?:^|; )" + CLIENT_ID_KEY + "=([^;]*)"));
        const value = match ? decodeURIComponent(match[1]) : "";
        return CLIENT_ID_RE.test(value) ? value : "";
      } catch {
        return "";
      }
    }
    // true when the browser really kept the cookie (blocked cookies must not look like "cleared")
    function writeClientCookie(value) {
      try {
        document.cookie = `${CLIENT_ID_KEY}=${encodeURIComponent(value)}; path=/; max-age=${CLIENT_COOKIE_MAX_AGE}; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
        return readClientCookie() === value;
      } catch {
        return false;
      }
    }
    function forgetOldVisitor(oldId) {
      // cookies were cleared: the earlier chat is no longer this browser's, and its email check ends with it
      try { localStorage.removeItem(storageKey); } catch {}
      if (!oldId) return;
      try {
        fetch("/apps/ai-agent/reset-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId: oldId, byShopper: false }),
          keepalive: true,
        }).catch(() => {});
      } catch {}
    }
    try {
      const fromCookie = readClientCookie();
      let stored = "";
      let cookieWasSet = false;
      try {
        stored = localStorage.getItem(CLIENT_ID_KEY) || "";
        cookieWasSet = localStorage.getItem(COOKIE_SEEN_KEY) === "1";
      } catch {}
      if (!CLIENT_ID_RE.test(stored)) stored = "";
      if (fromCookie) {
        clientId = fromCookie;
      } else if (stored && !cookieWasSet) {
        // a visitor from before cookies were used: keep their id and start the cookie from it
        clientId = stored;
      } else {
        if (stored && cookieWasSet) forgetOldVisitor(stored); // the cookie was there before and is gone now
        clientId = newClientId();
      }
      if (clientId) {
        const kept = writeClientCookie(clientId);
        try {
          localStorage.setItem(CLIENT_ID_KEY, clientId);
          if (kept) localStorage.setItem(COOKIE_SEEN_KEY, "1");
          else localStorage.removeItem(COOKIE_SEEN_KEY);
        } catch {}
      }
    } catch {
      clientId = newClientId();
    }
    // The server may replace an id it does not accept; keep using the one it returns.
    function adoptClientId(value) {
      if (typeof value !== "string" || !CLIENT_ID_RE.test(value) || value === clientId) {
        if (clientId) writeClientCookie(clientId); // every reply renews the cookie
        return;
      }
      clientId = value;
      const kept = writeClientCookie(clientId);
      try {
        localStorage.setItem(CLIENT_ID_KEY, clientId);
        if (kept) localStorage.setItem(COOKIE_SEEN_KEY, "1");
      } catch {}
    }

    // Marks the shopper's cart with the chat it came from, so the store owner's dashboard can count
    // orders that began in the chat (the reference is a public id, not the private client id).
    let taggedChatRef = "";
    function tagCartWithChat(ref, force) {
      if (typeof ref !== "string" || !/^[A-Za-z0-9_-]{10,40}$/.test(ref)) return;
      if (ref === taggedChatRef && !force) return;
      taggedChatRef = ref;
      fetch(cartUrl("cart/update.js"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ attributes: { ai_chat_ref: ref } }),
      }).catch(() => {
        taggedChatRef = "";
      });
    }

    function saveChatState() {
      if (restoringState) return;
      try {
        const transcript = [];
        Array.from(messages.children).forEach((node) => {
          if (node.classList.contains("ai-commerce-chat-message")) {
            const role = node.classList.contains("ai-commerce-chat-user") ? "user" : "bot";
            const content = node.dataset.rawText || node.textContent || "";
            const files = Array.isArray(node._files) ? node._files : undefined;
            if ((content.trim() || files) && !isThinkingText(content.trim())) {
              transcript.push({ type: "message", role, content: files ? node.dataset.rawText || "" : content, files, staff: node.dataset.staff === "1" ? true : undefined });
            }
          } else if (node.classList.contains("ai-commerce-product-grid")) {
            if (Array.isArray(node._products) && node._products.length > 0) {
              transcript.push({ type: "products", products: node._products });
            }
          } else if (node.classList.contains("ai-commerce-checkout-panel")) {
            if (node._action) {
              transcript.push({ type: "action", action: node._action });
            }
          } else if (node.classList.contains("ai-commerce-cart-preview")) {
            if (node._cart) {
              transcript.push({ type: "cart_preview", cart: node._cart });
            }
          } else if (node.classList.contains("ai-commerce-preview-card")) {
            if (node._preview) {
              transcript.push({ type: "preview", preview: node._preview });
            }
          }
        });

        // The saved chat keeps whole conversations: the limit counts what the shopper wrote and read (messages), not every
        // product card and panel between them, so a long chat is not cut in half. If the browser's storage is full, the
        // oldest part is dropped step by step (cards first) until it fits, instead of losing the whole save.
        const MAX_SAVED_MESSAGES = 200;
        let keptMessages = 0;
        let start = transcript.length;
        for (let i = transcript.length - 1; i >= 0; i--) {
          if (transcript[i].type === "message") keptMessages++;
          if (keptMessages > MAX_SAVED_MESSAGES) break;
          start = i;
        }
        let saved = transcript.slice(start);
        const build = (items) =>
          JSON.stringify({
            history: chatHistory.slice(-12),
            transcript: items,
            checkoutState,
            languageChoice: preferredLanguage || undefined,
            panelOpen: panel && !panel.hidden,
            savedAt: Date.now(),
            lastMessageAt: lastMessageAt || undefined,
          });
        for (let attempt = 0; attempt < 6; attempt++) {
          try {
            localStorage.setItem(storageKey, build(saved));
            break;
          } catch (storageError) {
            if (attempt === 5 || saved.length === 0) throw storageError;
            // product cards of the older half go first (they are the large part), then the older half altogether
            const half = Math.ceil(saved.length / 2);
            saved = attempt < 3 ? saved.filter((item, idx) => idx >= half || item.type === "message") : saved.slice(half);
          }
        }
        persistUiState();
        try {
          if (isSpeakingResponse && window.__aiCommerceLastSpeech) {
            localStorage.setItem(
              uiStateKey("pendingSpeech"),
              JSON.stringify({
                text: window.__aiCommerceLastSpeech,
                at: Date.now(),
              })
            );
          }
        } catch {}
      } catch {
        // ignore quota
      }
    }

    // Guest chat history lives for 30 days since the last message (refreshed on every save).
    const CHAT_HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

    // Tell the server the chat is gone so a previously verified email must be verified again.
    function notifyServerChatCleared(byShopper = false) {
      try {
        fetch("/apps/ai-agent/reset-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId, byShopper }),
          keepalive: true,
        }).catch(() => {});
      } catch {}
    }

    function restoreChatState() {
      restoringState = true;
      try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (!data) return;
        if (Date.now() - (data.savedAt || 0) > CHAT_HISTORY_TTL_MS) {
          // Chat expired: drop it and make the server forget the verified email too.
          localStorage.removeItem(storageKey);
          notifyServerChatCleared();
          return;
        }

        if (Array.isArray(data.history)) {
          chatHistory.length = 0;
          data.history.forEach((item) => chatHistory.push(item));
        }
        if (data.checkoutState) checkoutState = data.checkoutState;
        if (Number.isFinite(Number(data.lastMessageAt))) lastMessageAt = Number(data.lastMessageAt);
        if (["en", "hi", "hinglish"].includes(data.languageChoice)) {
          setPreferredLanguage(data.languageChoice);
        }
        const hadAnyTurn =
          (Array.isArray(data.history) && data.history.length > 0) ||
          (Array.isArray(data.transcript) && data.transcript.length > 0);
        if (hadAnyTurn) voiceGreetingDone = true;

        if (Array.isArray(data.transcript) && data.transcript.length > 0) {
          messages.innerHTML = "";
          ensureWelcomeBanner();
          data.transcript.forEach((item) => {
            if (item.type === "products") {
              if (Array.isArray(item.products) && item.products.length > 0) {
                renderProductCards(item.products);
              }
            } else if (item.type === "action") {
              if (item.action) {
                renderCheckoutPanel(item.action);
              }
            } else if (item.type === "cart_preview") {
              if (item.cart) {
                renderCartPreview(item.cart);
              }
            } else if (item.type === "preview") {
              if (item.preview) {
                renderGenericPreview(item.preview);
              }
            } else {
              const role = item.role === "user" ? "user" : "bot";
              const bubble = addMessage(item.content, role);
              if (item.staff) bubble.classList.add("ai-commerce-chat-staff"), (bubble.dataset.staff = "1");
              // The files themselves are gone after a reload (they were only in this page's memory); keep a labelled tile for each.
              if (role === "user" && Array.isArray(item.files) && item.files.length) attachGrid(bubble, item.files);
            }
          });
          messages.scrollTop = messages.scrollHeight;
          // The page was reloaded while an answer was on its way: the last thing in the chat is the shopper's own message.
          // Say so and offer to send it again, instead of leaving a question that looks ignored.
          const lastTurn = [...data.transcript].reverse().find((item) => item && (item.role || item.type === "message"));
          if (lastTurn && lastTurn.role === "user" && !lastTurn.staff && String(lastTurn.content || "").trim() && !(Array.isArray(lastTurn.files) && lastTurn.files.length)) {
            const lostText = String(lastTurn.content).trim();
            const note = addMessage(ui("lostReply"), "bot");
            const again = document.createElement("button");
            again.type = "button";
            again.className = "ai-commerce-chat-retry";
            again.textContent = ui("retry");
            again.addEventListener("click", () => {
              if (replyInFlight) return;
              note.remove();
              const lastBubbles = messages.querySelectorAll(".ai-commerce-chat-user");
              const lastBubble = lastBubbles[lastBubbles.length - 1];
              if (lastBubble) lastBubble.remove();
              const lastUserIdx = chatHistory.map((h) => h.role).lastIndexOf("user");
              if (lastUserIdx !== -1 && chatHistory[lastUserIdx].content === lostText) chatHistory.splice(lastUserIdx, 1);
              lastSentAt = 0;
              input.value = lostText;
              if (typeof form.requestSubmit === "function") form.requestSubmit();
            });
            note.appendChild(document.createElement("br"));
            note.appendChild(again);
          }
        }

        if (data.panelOpen === true) {
          try {
            localStorage.setItem(uiStateKey("open"), "1");
            sessionStorage.setItem(uiStateKey("open"), "1");
            writeFlagCookie(uiStateKey("open"), "1");
          } catch {}
        }
      } catch {
        // ignore
      } finally {
        restoringState = false;
      }
    }

    function cartRoot() {
      try {
        const r = window.Shopify && window.Shopify.routes && window.Shopify.routes.root;
        if (typeof r === "string" && r.length) return r.endsWith("/") ? r : r + "/";
      } catch {}
      return "/";
    }

    function cartUrl(path) {
      const p = String(path || "").replace(/^\//, "");
      return cartRoot() + p;
    }

    async function fetchCartSnapshot() {
      try {
        const response = await fetch(cartUrl("cart.js"), {
          headers: { Accept: "application/json" },
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) return null;
        const cart = await response.json();
        return {
          item_count: cart.item_count,
          total_price: cart.original_total_price ?? cart.total_price,
          // The currency/country the shopper is actually browsing in (Shopify Markets), so prices and the
          // order are calculated in that currency and not silently in the store's base currency.
          currency: cart.currency || (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || undefined,
          country: (window.Shopify && window.Shopify.country) || undefined,
          items: (cart.items || []).map((item) => ({
            title: item.product_title || item.title,
            variant_title: item.variant_title,
            quantity: item.quantity,
            line_price: item.original_line_price ?? item.line_price,
            final_line_price: item.original_line_price ?? item.final_line_price,
            product_id: item.product_id,
            variant_id: item.variant_id,
            key: item.key,
            image: item.image,
          })),
        };
      } catch {
        return null;
      }
    }

    // Tax / other-charge rows, identical in the Order Review card and the Order Placed card.
    // All numbers come from Shopify via the backend; nothing is calculated here.
    function appendTaxRows(parent, action, cur, style) {
      if (action.priceNotice && Number(action.priceNotice.shopifySubtotal) !== Number(action.priceNotice.storefrontSubtotal)) {
        const noticeRow = el(
          "p",
          "ai-commerce-checkout-hint",
          ui("ckPriceNotice", { shop: formatMoney(Number(action.priceNotice.shopifySubtotal), cur), store: formatMoney(Number(action.priceNotice.storefrontSubtotal), cur) })
        );
        noticeRow.style.cssText = style + "color:#b45309;";
        parent.appendChild(noticeRow);
      }
      if (action.tax == null) return;
      const lines = Array.isArray(action.taxLines) ? action.taxLines.filter((l) => l && l.title) : [];
      const unitemized = Number(action.unitemizedTax) || 0;
      const taxRow = el(
        "p",
        "ai-commerce-checkout-hint",
        `${ui(action.taxesIncluded ? "ckTaxIncl" : "ckTax")}: ${formatMoney(Number(action.tax), cur)}`
      );
      taxRow.style.cssText = style;
      parent.appendChild(taxRow);
      // Show what the tax total is made of, so the rows always add up to the payable total.
      if (!action.taxesIncluded && (lines.length > 1 || unitemized > 0 || (lines.length === 1 && Number(lines[0].amount) !== Number(action.tax)))) {
        lines.forEach((l) => {
          const part = el(
            "p",
            "ai-commerce-checkout-hint",
            `  ${l.title}${l.ratePercent != null ? " " + Number(l.ratePercent) + "%" : ""}: ${formatMoney(Number(l.amount) || 0, cur)}`
          );
          part.style.cssText = style + "padding-left:10px;font-size:11.5px;";
          parent.appendChild(part);
        });
        if (unitemized > 0) {
          const part = el(
            "p",
            "ai-commerce-checkout-hint",
            `  ${ui("ckOtherTax")}: ${formatMoney(unitemized, cur)}`
          );
          part.style.cssText = style + "padding-left:10px;font-size:11.5px;";
          parent.appendChild(part);
        }
      } else if (lines.length === 1) {
        taxRow.textContent = `${ui("ckTax")} (${lines[0].title}${lines[0].ratePercent != null ? " " + Number(lines[0].ratePercent) + "%" : ""})${action.taxesIncluded ? " – " + ui("ckInclShort") : ""}: ${formatMoney(Number(action.tax), cur)}`;
      }
      if (Number(action.otherCharges)) {
        const otherRow = el(
          "p",
          "ai-commerce-checkout-hint",
          `${ui("ckDuties")}: ${formatMoney(Number(action.otherCharges), cur)}`
        );
        otherRow.style.cssText = style;
        parent.appendChild(otherRow);
      }
    }

    function renderCheckoutPanel(action) {
      const panelEl = el("div", "ai-commerce-checkout-panel");
      panelEl._action = action;

      if (action.type === "begin_checkout") {
        const cart = action.cart || {};
        const cur = cart.currency || action.currency || "";
        const subtotalNum =
          action.originalTotal != null
            ? Number(action.originalTotal)
            : cart.total_price != null
            ? Number(cart.total_price) / 100
            : 0;
        const couponDiscountNum = Number(action.discountAmount) || 0;
        const finalTotalNum =
          action.total != null && couponDiscountNum > 0
            ? Number(action.total)
            : Math.max(0, Number((subtotalNum - couponDiscountNum).toFixed(2)));

        panelEl.appendChild(el("p", "ai-commerce-checkout-title", ui("ckCheckout")));

        const list = el("div", "ai-commerce-checkout-items");
        (cart.items || []).forEach((item) => {
          const row = el("div", "ai-commerce-checkout-item");
          const name = `${item.title || "Item"}${
            item.variant_title && item.variant_title !== "Default Title"
              ? " — " + item.variant_title
              : ""
          }`;
          row.appendChild(el("span", null, `${name} × ${item.quantity || 1}`));
          const price = formatMoney(Number(item.line_price ?? item.final_line_price) / 100, cur);
          if (price) row.appendChild(el("strong", null, price));
          list.appendChild(row);
        });
        panelEl.appendChild(list);

        if (couponDiscountNum > 0) {
          const codeLabel = action.appliedDiscount?.code
            ? `${action.appliedDiscount.code}${
                action.appliedDiscount.percent
                  ? " · " + action.appliedDiscount.percent + "% OFF"
                  : ""
              }`
            : ui("ckPromo");
          const subEl = el(
            "p",
            "ai-commerce-checkout-hint",
            `${ui("ckSubtotal")}: ${formatMoney(subtotalNum, cur)}`
          );
          subEl.style.cssText = "margin:6px 0 2px 0;color:#64748b;font-size:12.5px;";
          panelEl.appendChild(subEl);

          const discEl = el(
            "p",
            "ai-commerce-checkout-hint",
            `🎉 ${ui("ckCouponApplied", { label: codeLabel })}: -${formatMoney(couponDiscountNum, cur)}`
          );
          discEl.style.cssText =
            "margin:2px 0 4px 0;color:#15803d;font-weight:700;font-size:12.5px;";
          panelEl.appendChild(discEl);

          panelEl.appendChild(
            el(
              "p",
              "ai-commerce-checkout-total",
              `${ui("ckFinal")}: ${formatMoney(finalTotalNum, cur)}`
            )
          );
        } else if (subtotalNum > 0 || cart.total_price != null) {
          panelEl.appendChild(
            el(
              "p",
              "ai-commerce-checkout-total",
              `${ui("ckTotal")}: ${formatMoney(subtotalNum, cur)}`
            )
          );
        }
      }

      if (action.type === "set_shipping_address" || action.type === "set_billing_address") {
        const a = action.address || {};
        const isBilling = action.type === "set_billing_address";
        panelEl.appendChild(
          el(
            "p",
            "ai-commerce-checkout-title",
            isBilling ? ui("ckBillSaved") : ui("ckShipSaved")
          )
        );
        const addrText = isBilling && action.sameAsShipping
          ? ui("ckSameShip")
          : [a.name, a.address1, a.address2, a.city, a.province, a.zip, a.country].filter(Boolean).join(", ");
        panelEl.appendChild(
          el(
            "p",
            "ai-commerce-checkout-hint",
            addrText
          )
        );
      }

      if (action.type === "checkout_ready") {
        const cart = action.cart || {};
        const ship = action.shipping || {};
        const cur = cart.currency || action.currency || "";

        const rawCartSubtotal =
          cart.total_price != null ? Number(cart.total_price) / 100 : 0;
        const subtotalNum =
          action.originalTotal != null && Number(action.originalTotal) > 0
            ? Number(action.originalTotal)
            : rawCartSubtotal;

        const couponDiscountNum =
          action.discountAmount != null
            ? Number(action.discountAmount)
            : action.appliedDiscount?.amount != null
            ? Number(action.appliedDiscount.amount)
            : 0;

        const couponPct = Number(action.appliedDiscount?.percent) || 0;
        // Shipping = the store's own Shopify rate chosen for this checkout (title + price from the server).
        const shippingRates = Array.isArray(action.shippingRates) ? action.shippingRates : [];
        const shippingMethod = String(action.shippingMethod || "").trim();
        const shippingTitle =
          shippingMethod && shippingMethod.toLowerCase() !== "standard" ? shippingMethod : ui("ckShipping");
        const shippingCostNum = Number(action.shippingCost) || 0;

        const discountedSubtotalNum =
          action.discountedSubtotal != null
            ? Number(action.discountedSubtotal)
            : Math.max(0, Number((subtotalNum - couponDiscountNum).toFixed(2)));

        const finalTotalNum =
          action.total != null &&
          (action.tax != null ||
            couponDiscountNum > 0 ||
            shippingCostNum > 0 ||
            Number(action.total) < subtotalNum)
            ? Number(action.total)
            : Math.max(
                0,
                Number((discountedSubtotalNum + shippingCostNum).toFixed(2))
              );

        const prepaidTotal =
          action.prepaidTotal != null
            ? Number(action.prepaidTotal)
            : finalTotalNum;

        panelEl.classList.add("ai-commerce-order-confirm");
        panelEl.appendChild(el("p", "ai-commerce-checkout-title", ui("ckReview")));

        const itemsWrap = el("div", "ai-commerce-checkout-items");
        (cart.items || []).forEach((item) => {
          const row = el("div", "ai-commerce-order-row");
          if (item.image) {
            const img = el("img", "ai-commerce-order-img");
            img.src = safeUrl(item.image);
            img.alt = item.title || "";
            row.appendChild(img);
          }
          const info = el("div", "ai-commerce-order-info");
          const name =
            item.variant_title && item.variant_title !== "Default Title"
              ? `${item.title} — ${item.variant_title}`
              : item.title || "Item";
          info.appendChild(el("p", "ai-commerce-order-name", name));

          const lineOrig =
            item.line_price != null ? Number(item.line_price) / 100 : 0;
          // A code limited to a collection or to named products discounts only its own lines (scopeVariantIds): a mouse outside
          // CHAT20's collection showed "-₹180" on a real run while the total (correctly) left it out (2026-11-21).
          const lineScope = Array.isArray(action.appliedDiscount?.scopeVariantIds) ? action.appliedDiscount.scopeVariantIds.map(String) : null;
          const lineCovered = !lineScope || lineScope.includes(String(item.variant_id ?? item.id ?? ""));
          const lineDisc =
            couponPct > 0 && lineCovered
              ? Number((lineOrig * (1 - couponPct / 100)).toFixed(2))
              : lineOrig;
          const lineSave = Math.max(0, Number((lineOrig - lineDisc).toFixed(2)));

          const metaText =
            lineSave > 0
              ? `${ui("ckQty", { n: item.quantity || 1 })} · ${ui("ckOrigShort")}: ${formatMoney(
                  lineOrig,
                  cur
                )} → ${ui("ckDiscounted")}: ${formatMoney(lineDisc, cur)} (${
                  action.appliedDiscount?.code || "PROMO"
                } -${formatMoney(lineSave, cur)})`
              : `${ui("ckQty", { n: item.quantity || 1 })}${
                  item.line_price != null
                    ? " · " + formatMoney(Number(item.line_price) / 100, cur)
                    : ""
                }`;

          info.appendChild(el("p", "ai-commerce-order-meta", metaText));
          row.appendChild(info);
          itemsWrap.appendChild(row);
        });
        panelEl.appendChild(itemsWrap);

        // Shipping selector: only the rates the store really offers for this address (from Shopify).
        if (shippingRates.length > 1) {
          const shipMethodBox = el("div", "ai-commerce-shipping-methods");
          shipMethodBox.style.cssText =
            "margin:8px 0;padding:8px 10px;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;";
          const shipMethodLabel = el("p", "ai-commerce-order-address-label", ui("ckShipMethod"));
          shipMethodLabel.style.cssText = "margin:0 0 6px 0;font-weight:700;font-size:12px;color:#334155;";
          shipMethodBox.appendChild(shipMethodLabel);
          const shipBtnRow = el("div", null);
          shipBtnRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
          shippingRates.forEach((rate) => {
            const title = String(rate?.title || "").trim();
            if (!title) return;
            const price = Number(rate.price) || 0;
            const btn = el(
              "button",
              "ai-commerce-checkout-btn",
              `${title} (${price > 0 ? formatMoney(price, rate.currency || cur) : ui("ckFree")})`
            );
            btn.type = "button";
            const selected = title.toLowerCase() === shippingMethod.toLowerCase();
            btn.style.cssText = selected
              ? "flex:1;min-width:120px;padding:6px 10px;border-radius:8px;border:2px solid #0f172a;background:#f1f5f9;color:#0f172a;font-size:11.5px;font-weight:700;cursor:pointer;"
              : "flex:1;min-width:120px;padding:6px 10px;border-radius:8px;border:1px solid #cbd5e1;background:#ffffff;color:#475569;font-size:11.5px;font-weight:600;cursor:pointer;";
            btn.addEventListener("click", () => {
              input.value = `Switch shipping to ${title}`;
              form.requestSubmit();
            });
            shipBtnRow.appendChild(btn);
          });
          shipMethodBox.appendChild(shipBtnRow);
          panelEl.appendChild(shipMethodBox);
        }

        // Cost Summary Box
        const pricingWrap = el("div", "ai-commerce-pricing-summary");
        pricingWrap.style.cssText =
          "margin:8px 0;padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;";

        if (couponDiscountNum > 0) {
          const codeLabel = action.appliedDiscount?.code
            ? `${action.appliedDiscount.code}${
                action.appliedDiscount.percent
                  ? " · " + action.appliedDiscount.percent + "% OFF"
                  : ""
              }`
            : ui("ckCoupon");

          const origRow = el(
            "p",
            "ai-commerce-checkout-hint",
            `${ui("ckOrig")}: ${formatMoney(subtotalNum, cur)}`
          );
          origRow.style.cssText =
            "margin:0 0 3px 0;color:#64748b;font-size:12px;text-decoration:line-through;";
          pricingWrap.appendChild(origRow);

          const discRow = el(
            "p",
            "ai-commerce-checkout-hint",
            `🏷️ Discount code (${codeLabel}): -${formatMoney(couponDiscountNum, cur)}`
          );
          discRow.style.cssText =
            "margin:0 0 4px 0;color:#15803d;font-weight:700;font-size:12.5px;";
          pricingWrap.appendChild(discRow);

          const subRow = el(
            "p",
            "ai-commerce-checkout-hint",
            `${ui("ckSubtotal")}: ${formatMoney(discountedSubtotalNum, cur)}`
          );
          subRow.style.cssText =
            "margin:0 0 3px 0;color:#334155;font-weight:600;font-size:12.5px;";
          pricingWrap.appendChild(subRow);
        } else {
          const subRow = el(
            "p",
            "ai-commerce-checkout-hint",
            `${ui("ckSubtotal")}: ${formatMoney(subtotalNum, cur)}`
          );
          subRow.style.cssText =
            "margin:0 0 3px 0;color:#334155;font-weight:600;font-size:12.5px;";
          pricingWrap.appendChild(subRow);
        }

        const shipCostRow = el(
          "p",
          "ai-commerce-checkout-hint",
          `${shippingTitle}: ${
            shippingCostNum > 0 ? formatMoney(shippingCostNum, cur) : ui("ckFree")
          }`
        );
        shipCostRow.style.cssText =
          "margin:0 0 5px 0;color:#475569;font-size:12.5px;";
        pricingWrap.appendChild(shipCostRow);

        appendTaxRows(
          pricingWrap,
          action,
          cur,
          "margin:0 0 5px 0;color:#475569;font-size:12.5px;"
        );

        const totRow = el(
          "p",
          "ai-commerce-checkout-total",
          `${ui(action.tax != null ? "ckTotalTax" : "ckTotalCur", { cur })}: ${formatMoney(finalTotalNum, cur)}`
        );
        totRow.style.cssText = "margin:0;font-weight:800;color:#0f172a;font-size:14px;";
        pricingWrap.appendChild(totRow);

        if (couponDiscountNum > 0) {
          const savRow = el(
            "p",
            "ai-commerce-checkout-hint",
            `🎉 ${ui("ckSavings")}: ${formatMoney(couponDiscountNum, cur)}`
          );
          savRow.style.cssText =
            "margin:5px 0 0 0;color:#15803d;font-weight:800;font-size:12px;";
          pricingWrap.appendChild(savRow);
        }

        panelEl.appendChild(pricingWrap);

        const addrBox = el("div", "ai-commerce-order-address");
        addrBox.appendChild(el("p", "ai-commerce-order-address-label", ui("ckDelivery")));
        addrBox.appendChild(
          el(
            "p",
            "ai-commerce-order-address-text",
            [
              ship.name,
              ship.address1,
              ship.address2,
              ship.city,
              ship.province,
              ship.zip,
              ship.country,
              ship.phone,
              action.email || ship.email,
            ]
              .filter(Boolean)
              .join(", ")
          )
        );
        panelEl.appendChild(addrBox);

        const bill = action.billing || {};
        const isSameBill = Boolean(action.billingSameAsShipping ?? (!bill.address1 || bill.address1 === ship.address1));
        const billBox = el("div", "ai-commerce-order-address");
        billBox.style.cssText = "margin-top:6px;";
        billBox.appendChild(el("p", "ai-commerce-order-address-label", ui("ckBilling")));
        billBox.appendChild(
          el(
            "p",
            "ai-commerce-order-address-text",
            isSameBill
              ? ui("ckSameShip")
              : [
                  bill.name || ship.name,
                  bill.address1,
                  bill.address2,
                  bill.city,
                  bill.province,
                  bill.zip,
                  bill.country,
                  bill.phone || ship.phone,
                ]
                  .filter(Boolean)
                  .join(", ")
          )
        );
        panelEl.appendChild(billBox);

        const hasDiscount = Boolean(
          action.hasPrepaidDiscount &&
            ((Number(action.prepaidDiscountAmount) || 0) > 0 ||
              (Number(action.prepaidDiscountPercent) || 0) > 0)
        );
        const saveLabel = action.prepaidDiscountPercent
          ? `${action.prepaidDiscountPercent}%`
          : formatMoney(action.prepaidDiscountAmount || 0, cur);

        if (hasDiscount) {
          const offerBox = el("div", "ai-commerce-checkout-offer");
          offerBox.style.cssText =
            "background:#f0fdf4;border:1px solid #86efac;color:#166534;padding:8px 12px;border-radius:8px;margin:10px 0 6px 0;font-size:12.5px;font-weight:600;line-height:1.4;";
          offerBox.textContent = `🎉 ${ui("ckPrepaidOffer", { save: saveLabel, pay: formatMoney(prepaidTotal, cur) })}`;
          panelEl.appendChild(offerBox);
        }

        const payActions = el("div", "ai-commerce-checkout-actions");
        payActions.style.cssText = "display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;";

        const codBtn = el("button", "ai-commerce-checkout-btn", ui("ckCod"));
        codBtn.type = "button";
        codBtn.style.cssText =
          "flex:1;min-width:130px;padding:9px 12px;border-radius:999px;border:1px solid #cbd5e1;background:#ffffff;color:#0f172a;font-size:12.5px;font-weight:600;cursor:pointer;";
        codBtn.addEventListener("click", () => {
          input.value = ui("ckMsgCod");
          form.requestSubmit();
        });

        const prepaidBtnLabel = hasDiscount
          ? ui("ckPayOnlineSave", { save: saveLabel })
          : ui("ckPayOnline");
        const prepaidBtn = el("button", "ai-commerce-checkout-btn", prepaidBtnLabel);
        prepaidBtn.type = "button";
        prepaidBtn.style.cssText =
          "flex:1;min-width:130px;padding:9px 12px;border-radius:999px;border:none;background:#0f172a;color:#ffffff;font-size:12.5px;font-weight:700;cursor:pointer;";
        prepaidBtn.addEventListener("click", () => {
          input.value = hasDiscount
            ? ui("ckMsgPrepaidSave", { save: saveLabel })
            : ui("ckMsgPrepaid");
          form.requestSubmit();
        });

        payActions.appendChild(codBtn);
        payActions.appendChild(prepaidBtn);
        panelEl.appendChild(payActions);
      }

      if (action.type === "order_placed") {
        panelEl.classList.add("ai-commerce-order-confirm", "is-placed");
        panelEl.style.cssText =
          "border:2px solid #22c55e;background:#f0fdf4;padding:14px;border-radius:14px;";

        const badgeTitle = el(
          "p",
          "ai-commerce-checkout-title",
          "🎉 " + ui("ckPlaced")
        );
        badgeTitle.style.cssText = "color:#15803d;font-weight:700;margin:0 0 4px 0;";
        panelEl.appendChild(badgeTitle);

        const cur = action.currency || "";
        const hasCouponOrPrepaid = Number(action.discountAmount) > 0;
        const couponCodeStr = action.appliedDiscount?.code || action.discountCode
          ? `${action.appliedDiscount?.code || action.discountCode}${
              action.discountPercent ? " · " + action.discountPercent + "% OFF" : ""
            }`
          : action.discountPercent
          ? `${action.discountPercent}% OFF`
          : ui("ckDiscApplied");

        const methodLabel =
          action.paymentMethod === "prepaid"
            ? hasCouponOrPrepaid
              ? `${ui("ckPrepaid")} · ${couponCodeStr}`
              : ui("ckPrepaid")
            : hasCouponOrPrepaid
            ? `${ui("ckCod")} · ${couponCodeStr}`
            : ui("ckCod");

        const shipMethodTitle =
          action.shippingMethod && String(action.shippingMethod).toLowerCase() !== "standard"
            ? String(action.shippingMethod)
            : ui("ckShipping");
        const shipMethodName = `${shipMethodTitle} (${
          Number(action.shippingCost) > 0 ? formatMoney(Number(action.shippingCost), cur) : ui("ckFree")
        })`;

        panelEl.appendChild(
          el(
            "p",
            "ai-commerce-checkout-hint",
            `${ui("ckOrderId")}: ${action.orderId || ""} · ${ui("ckPayment")}: ${methodLabel} · ${ui("ckShipping")}: ${shipMethodName}`
          )
        );

        if (action.recipientEmail) {
          panelEl.appendChild(
            el(
              "p",
              "ai-commerce-checkout-hint",
              "📧 " + ui("ckEmailSent", { email: action.recipientEmail })
            )
          );
        }

        const couponPct = Number(action.discountPercent) || 0;
        const itemsWrap = el("div", "ai-commerce-checkout-items");
        ((action.cart && action.cart.items) || []).forEach((item) => {
          const row = el("div", "ai-commerce-order-row");
          if (item.image) {
            const img = el("img", "ai-commerce-order-img");
            img.src = safeUrl(item.image);
            img.alt = item.title || "";
            row.appendChild(img);
          }
          const info = el("div", "ai-commerce-order-info");
          const name =
            item.variant_title && item.variant_title !== "Default Title"
              ? `${item.title} — ${item.variant_title}`
              : item.title || "Item";
          info.appendChild(el("p", "ai-commerce-order-name", name));

          const lineOrig =
            item.line_price != null ? Number(item.line_price) / 100 : 0;
          // A code limited to a collection or to named products discounts only its own lines (scopeVariantIds): a mouse outside
          // CHAT20's collection showed "-₹180" on a real run while the total (correctly) left it out (2026-11-21).
          const lineScope = Array.isArray(action.appliedDiscount?.scopeVariantIds) ? action.appliedDiscount.scopeVariantIds.map(String) : null;
          const lineCovered = !lineScope || lineScope.includes(String(item.variant_id ?? item.id ?? ""));
          const lineDisc =
            couponPct > 0 && lineCovered
              ? Number((lineOrig * (1 - couponPct / 100)).toFixed(2))
              : lineOrig;
          const metaStr =
            couponPct > 0 && lineOrig > 0 && lineDisc < lineOrig
              ? `Qty ${item.quantity || 1} · Original: ${formatMoney(
                  lineOrig,
                  cur
                )} → Discounted: ${formatMoney(lineDisc, cur)}`
              : `${ui("ckQty", { n: item.quantity || 1 })}${
                  lineOrig > 0 ? " · " + formatMoney(lineOrig, cur) : ""
                }`;

          info.appendChild(el("p", "ai-commerce-order-meta", metaStr));
          row.appendChild(info);
          itemsWrap.appendChild(row);
        });
        panelEl.appendChild(itemsWrap);

        const origSub =
          action.originalTotal != null ? Number(action.originalTotal) : null;
        const discAmt =
          action.discountAmount != null ? Number(action.discountAmount) : 0;
        const discSub =
          action.discountedSubtotal != null
            ? Number(action.discountedSubtotal)
            : origSub != null
            ? Math.max(0, Number((origSub - discAmt).toFixed(2)))
            : null;
        const shipCostNum =
          action.shippingCost != null ? Number(action.shippingCost) : 0;
        const totStr = action.total != null ? formatMoney(action.total, cur) : "";

        if (discAmt > 0 && origSub != null) {
          const subEl = el(
            "p",
            "ai-commerce-checkout-hint",
            `Original: ${formatMoney(origSub, cur)} · Discount (${couponCodeStr}): -${formatMoney(
              discAmt,
              cur
            )} · Subtotal: ${formatMoney(discSub, cur)} · Shipping: ${
              shipCostNum > 0 ? formatMoney(shipCostNum, cur) : "FREE"
            }`
          );
          subEl.style.cssText = "color:#15803d;font-weight:600;margin-top:6px;font-size:12.5px;";
          panelEl.appendChild(subEl);
        } else if (shipCostNum > 0) {
          const shipEl = el(
            "p",
            "ai-commerce-checkout-hint",
            `Shipping: ${formatMoney(shipCostNum, cur)}`
          );
          shipEl.style.cssText = "color:#475569;font-weight:600;margin-top:6px;font-size:12.5px;";
          panelEl.appendChild(shipEl);
        }

        appendTaxRows(
          panelEl,
          action,
          cur,
          "color:#475569;font-weight:600;margin-top:4px;font-size:12.5px;"
        );

        if (totStr) {
          const totEl = el(
            "p",
            "ai-commerce-checkout-total",
            `Total (${cur}): ${totStr}${
              discAmt > 0 ? "  (TOTAL SAVINGS: " + formatMoney(discAmt, cur) + ")" : ""
            }`
          );
          totEl.style.cssText = "font-weight:800;color:#0f172a;margin-top:4px;";
          panelEl.appendChild(totEl);
        }

        const ship = action.shipping || {};
        if (ship.address1 || ship.city) {
          const addrBox = el("div", "ai-commerce-order-address");
          addrBox.appendChild(el("p", "ai-commerce-order-address-label", "Delivering to"));
          addrBox.appendChild(
            el(
              "p",
              "ai-commerce-order-address-text",
              [
                ship.name,
                ship.address1,
                ship.address2,
                ship.city,
                ship.province,
                ship.zip,
                ship.country,
                ship.phone,
                action.recipientEmail,
              ]
                .filter(Boolean)
                .join(", ")
            )
          );
          panelEl.appendChild(addrBox);

          const bill = action.billing || {};
          const isSameBill = Boolean(action.billingSameAsShipping ?? (!bill.address1 || bill.address1 === ship.address1));
          const billBox = el("div", "ai-commerce-order-address");
          billBox.style.cssText = "margin-top:6px;";
          billBox.appendChild(el("p", "ai-commerce-order-address-label", ui("ckBilling")));
          billBox.appendChild(
            el(
              "p",
              "ai-commerce-order-address-text",
              isSameBill
                ? "Same as delivery address"
                : [
                    bill.name || ship.name,
                    bill.address1,
                    bill.address2,
                    bill.city,
                    bill.province,
                    bill.zip,
                    bill.country,
                    bill.phone || ship.phone,
                  ]
                    .filter(Boolean)
                    .join(", ")
            )
          );
          panelEl.appendChild(billBox);
        }

        if (cartCount) cartCount.hidden = true;
      }

      if (action.type === "apply_discount") {
        panelEl.classList.add("ai-commerce-order-confirm");
        panelEl.style.cssText =
          "border:1.5px solid #86efac;background:#f0fdf4;padding:12px 14px;border-radius:12px;";
        panelEl.appendChild(el("p", "ai-commerce-checkout-title", "🎉 Coupon Applied to Order!"));
        const row = el("div", "ai-commerce-order-row");
        const codeText = `${action.discountCode || action.discountTitle}${
          action.discountPercent ? " (" + action.discountPercent + "% OFF)" : ""
        }`;
        row.appendChild(el("strong", null, codeText));
        row.appendChild(
          el(
            "span",
            null,
            action.isFreeShipping
              ? "Free Shipping"
              : "-" + (action.formattedDiscount || "")
          )
        );
        panelEl.appendChild(row);

        if (action.formattedOriginalTotal && !action.isFreeShipping) {
          const subLine = el(
            "p",
            "ai-commerce-checkout-hint",
            `${ui("ckCartSub")}: ${action.formattedOriginalTotal}`
          );
          subLine.style.cssText = "margin:4px 0 2px 0;color:#64748b;font-size:12px;";
          panelEl.appendChild(subLine);
        }

        if (action.formattedNewTotal) {
          const newTotEl = el(
            "p",
            "ai-commerce-checkout-total",
            `${ui("ckAfterDisc")}: ${action.formattedNewTotal}`
          );
          newTotEl.style.cssText = "font-weight:800;color:#15803d;margin-top:4px;";
          panelEl.appendChild(newTotEl);

          // The earlier panels keep their own totals: those include tax and shipping, and this card's amount does not. A real run
          // rewrote them to "Final Payable Total" with the pre-tax subtotal (2026-11-21). The fresh order review shows the new total.
          messages.querySelectorAll(".ai-commerce-checkout-panel").forEach((panel) => {
            if (panel.classList.contains("ai-commerce-order-confirm")) return;
            const totalEl = panel.querySelector(".ai-commerce-checkout-total");
            if (!panel.querySelector(".ai-commerce-coupon-applied-hint") && action.formattedDiscount) {
              const hintEl = el("p", "ai-commerce-coupon-applied-hint", `🎉 ${ui("ckCoupon")} (${codeText}): -${action.formattedDiscount} (${ui("ckCartSub")}: ${action.formattedOriginalTotal})`);
              hintEl.style.cssText = "margin:4px 0 2px 0;color:#15803d;font-weight:700;font-size:12.5px;";
              if (totalEl) {
                panel.insertBefore(hintEl, totalEl);
              } else {
                panel.appendChild(hintEl);
              }
            }
          });
        }
      }

      messages.appendChild(panelEl);
      messages.scrollTop = messages.scrollHeight;
      if (!restoringState) saveChatState();
    }

    function handleCheckoutActions(actions) {
      if (!Array.isArray(actions)) return;
      for (const action of actions) {
        if (!action || !action.type) continue;
        if (
          action.type === "begin_checkout" ||
          action.type === "set_shipping_address" ||
          action.type === "set_billing_address" ||
          action.type === "checkout_ready" ||
          action.type === "order_placed" ||
          action.type === "apply_discount"
        ) {
          renderCheckoutPanel(action);
        }
      }
    }

    const MAX_BUFFER_SECONDS = 2;
    const TARGET_SAMPLE_RATE = 16000;

    const ENABLE_BARGE_IN = true;
    // ~43 ms per audio frame (2048 samples at 48 kHz): small frames = fast reaction to interruptions.
    const MIC_FRAME_SAMPLES = 2048;
    // Speech kept from just before the interruption (~350 ms) so the first word is not lost.
    const BARGE_IN_PREROLL_CHUNKS = 8;
    const POST_SPEECH_MUTE_MS = 220;

    // BARGE_IN_DETECTOR_START
    // Decides, frame by frame, whether the shopper started talking over the assistant.
    // Balanced, not "very loud only" and not "every noise":
    //  - the room's background level is learned while the shopper is quiet (noise floor);
    //  - the assistant's own echo in the mic is learned at the start of each reply (short grace);
    //  - a frame counts as voice only above max(minimum, 3x noise, 1.5x the loudest recent echo);
    //  - a short dip between syllables does not reset the count (leaky counter), so normal speech
    //    triggers in about 130 ms, and a clearly loud start triggers in about 85 ms.
    function createBargeInDetector(options = {}) {
      const cfg = {
        minRms: 0.018,
        noiseFactor: 3,
        echoFactor: 1.5,
        graceFrames: 4,
        triggerScore: 4,
        strongFactor: 2.2,
        strongFrames: 3,
        // The browser's speech synthesis is played by the operating system, outside what the browser's echo canceller knows
        // about, so its sound comes back through the microphone. While it speaks, the shopper must be clearly louder than
        // that echo, for longer, before it counts as an interruption, and even then the words decide (see the barge-in candidate).
        // the voice is paused on this first detection, which also silences the echo, so it can be quick and cheap to be wrong
        strictGraceFrames: 4,
        strictEchoFactor: 2,
        strictTriggerScore: 3,
        strictStrongFactor: 3,
        ...options,
      };
      let noiseFloor = 0.004;
      let echo = 0;
      let frames = 0;
      let score = 0;
      let strong = 0;
      let strict = false;
      return {
        // while the assistant is NOT speaking: learn the background level of the room
        observeQuiet(level) {
          if (level < noiseFloor * 4 || level < cfg.minRms) noiseFloor = noiseFloor * 0.95 + Math.min(level, cfg.minRms) * 0.05;
          // A steady louder sound (fan, AC, traffic) is learned too, slowly (over several seconds), so
          // it stops counting as voice; a sentence is far too short to be learned away.
          else noiseFloor = noiseFloor * 0.996 + level * 0.004;
        },
        startReply(opts = {}) {
          strict = Boolean(opts.strict);
          echo = 0;
          frames = 0;
          score = 0;
          strong = 0;
        },
        threshold() {
          return Math.max(cfg.minRms, noiseFloor * cfg.noiseFactor, echo * (strict ? cfg.strictEchoFactor : cfg.echoFactor));
        },
        // while the assistant is quiet: is the shopper's voice in this frame (above the room's noise)?
        isVoice(level) {
          return level > Math.max(cfg.minRms, noiseFloor * cfg.noiseFactor);
        },
        // while the assistant IS speaking: returns true when the shopper interrupts
        hear(level) {
          frames++;
          if (frames <= (strict ? cfg.strictGraceFrames : cfg.graceFrames)) {
            echo = Math.max(echo, level);
            return false;
          }
          const limit = this.threshold();
          if (level > limit) {
            score += 1;
            strong = level > limit * (strict ? cfg.strictStrongFactor : cfg.strongFactor) ? strong + 1 : 0;
          } else {
            score = Math.max(0, score - 0.5);
            strong = 0;
            // follow the loudest recent echo (it changes with what the assistant says), decaying slowly
            echo = Math.max(echo * 0.98, level);
          }
          if (score >= (strict ? cfg.strictTriggerScore : cfg.triggerScore) || strong >= cfg.strongFrames) {
            score = 0;
            strong = 0;
            return true;
          }
          return false;
        },
      };
    }
    // BARGE_IN_DETECTOR_END

    // BARGE_IN_GATE_START
    // Is it really the shopper talking, or just a knock / cough? Decided on the device, in about half
    // a second, from how long the voice lasts (waiting for the server's transcript was too slow):
    //   begin()        -> the detector heard something voice-like; the assistant keeps talking
    //   frame(voiced)  -> each next mic frame; returns "stop" once enough of it was voice
    //   expired()      -> the window ended without enough voice: it was a noise, nothing happens
    // While deciding, nothing is sent; once it is real speech, everything heard so far is sent, so
    // the shopper's first words are not lost.
    function createBargeInGate({ windowMs = 700, voicedFrames = 3, now = () => Date.now() } = {}) {
      let until = 0;
      let voiced = 0;
      return {
        begin() {
          if (until > now()) return false;
          until = now() + windowMs;
          voiced = 0;
          return true;
        },
        active() {
          return until > now();
        },
        frame(isVoiced) {
          if (!(until > now())) return "";
          if (isVoiced) voiced += 1;
          if (voiced >= voicedFrames) {
            until = 0;
            voiced = 0;
            return "stop";
          }
          return "";
        },
        expired() {
          return until !== 0 && until <= now();
        },
        cancel() {
          until = 0;
          voiced = 0;
        },
      };
    }

    // Speech that has words in it (not just "...", "hmm" noise or punctuation):
    // letters with their vowel signs (Hindi "रुको"), or a number
    function hasWords(text) {
      return /[\p{L}\p{N}][\p{L}\p{M}\p{N}]+/u.test(String(text || ""));
    }
    // BARGE_IN_GATE_END
    const bargeIn = createBargeInDetector();
    const bargeGate = createBargeInGate();
    let micMutedUntil = 0;

    const MIC_ICON =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';
    const STOP_ICON =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="2" y1="2" x2="22" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';

    // ---- Interface text: English by default, real Hindi (Devanagari) when Hindi is chosen. ----
    // Only chrome lives here. Every reply the shopper reads is written by the AI.
    const UI = {
      en: {
        today: "Today",
        // shown only when the AI's opening line is empty or late AND the merchant set no greeting of their own: never a blank chat
        defaultGreeting: "Hi! Welcome to {shop}. What are you looking for today?", defaultGreetingNoShop: "Hi! What are you looking for today?",
        ckCheckout: "Checkout", ckReview: "Order Review", ckSubtotal: "Subtotal", ckTotal: "Total", ckFinal: "Final Payable Total",
        ckTotalTax: "Total ({cur}, incl. tax)", ckTotalCur: "Total ({cur})", ckFree: "FREE", ckShipping: "Shipping", ckShipMethod: "Shipping method",
        ckDelivery: "Delivery Address", ckBilling: "Billing Address", ckSameShip: "Same as shipping address",
        ckShipSaved: "Shipping address saved", ckBillSaved: "Billing address saved", ckQty: "Qty {n}", ckOrig: "Original price", ckOrigShort: "Original", ckDiscounted: "Discounted", ckCartSub: "Cart subtotal", ckAfterDisc: "Subtotal after discount (tax and shipping are added in the order review)", ckCoupon: "Coupon applied",
        ckCouponApplied: "Coupon Applied ({label})", ckCoupon: "Coupon Discount", ckPromo: "Promo Discount", ckDiscApplied: "Discount Applied", ckSavings: "TOTAL SAVINGS",
        ckTax: "Tax", ckTaxIncl: "Tax – included in prices", ckInclShort: "included in prices", ckOtherTax: "Other taxes/duties (not itemized by Shopify)", ckDuties: "Duties & other charges",
        ckPriceNotice: "Shopify prices these items at {shop} for this destination (storefront cart: {store})",
        ckPrepaidOffer: "Prepaid Offer: Save {save} on online payment (Pay only {pay})!", ckCod: "Cash on Delivery", ckPrepaid: "Prepaid (Online Payment)",
        ckPayOnline: "Pay Online (Prepaid)", ckPayOnlineSave: "Pay Online (Save {save})",
        ckMsgCod: "I'll pay by Cash on Delivery", ckMsgPrepaid: "I'll pay online (prepaid)", ckMsgPrepaidSave: "I'll pay online (prepaid) and get {save} off",
        ckPlaced: "Order Placed Successfully!", ckOrderId: "Order ID", ckPayment: "Payment", ckEmailSent: "Confirmation email sent to {email}",

        clearChat: "Clear chat", clearTitle: "Clear this chat?",
        clearBody: "This removes the conversation from your screen. The store keeps a copy so its team can help you if needed. Your cart is not affected.",
        cancel: "Cancel", clearConfirm: "Clear chat", cleared: "Chat cleared",
        connected: "Connected", endCall: "End call", mute: "Mute", unmute: "Unmute",
        micOn: "Mic on", micPaused: "Mic paused", micMuted: "Mic muted",
        lblListen: "Listening…", lblYou: "You're speaking", lblThink: "Thinking…", lblSpeak: "Speaking", lblMuted: "Mic is muted", lblConnecting: "Connecting…",
        subListen: "Just speak. No need to tap the mic.", subThink: "Mic is paused while I think.", subSpeak: "Speak anytime to interrupt me.", subMuted: "Unmute, then speak.",
        ph: "Ask me anything…", phListen: "Listening to your voice…", phFiles: "Add a message, or just send…",
        teaser: ["Need help finding something?", "Ask me about products, orders or delivery", "Tap to chat or talk with Orbi"],
        tBack: "Pick up where you left off", liveWait: "Preparing your reply…",
        attached: "{n} of {max} attached", tooMany: "You can attach up to {max} files.", tooBig: "{name} is too large.", badType: "{name} is not supported.",
        findSimilar: "Find similar", findSimilarMsg: "Find products similar to my photo", uploadFail: "Couldn't upload your files. Please try again.", sendingFiles: "Sending your files…",
        busy: "Lots of messages right now. Please wait a moment and try again.", voiceBusy: "Voice is busy right now. Please try again in a minute, or keep chatting here.", uploadFull: "This store can't take more files right now. Please describe it in words instead.", uploadCheck: "Files can't be checked right now. Please try again later.", connectFail: "Sorry, I couldn't connect to the shopping assistant. Please try again.", emptyMsg: "Please type a message with some words in it.", lostReply: "The page was reloaded before I could answer your last message.", chatTimeout: "This is taking longer than expected, so I stopped waiting. Your message was not lost: you can try again.", retry: "Retry",
        openAria: "Open Orbi AI shopping assistant", minAria: "Minimize chat", closeAria: "Close chat", menuAria: "More options",
        attachAria: "Attach photos, videos or PDFs", removeAll: "Remove all", removeOne: "Remove", dismiss: "Dismiss",
        micStart: "Enable Microphone", micStop: "Disable Microphone",
        adding: "Adding…", proceedCheckout: "Proceed to Checkout →", cartAddFail: "Shopify could not add this product to the cart.", pickVariant: "Please choose an option (like size or colour) for this product first, then I will add it.", cartLineFail: "I could not update that cart line. Please try from the cart page.", cartUpdateFail: "Could not update the cart. Please try again.", voiceReceiving: "Receiving audio…", voiceError: "Voice session error. Please try again.", setupNeeded: "This chat is still being set up by the store. Please try again later.", voiceHttps: "Voice needs a secure connection. Please use the text chat.", voiceConnecting: "Connecting voice session…", voiceUnavailable: "Voice is unavailable right now. Please use the text chat.", voiceConnected: "Voice connected. Listening…", micFail: "Could not start the microphone. Please allow microphone access and try again.", micDenied: "Microphone access is blocked for this site. Click the lock or camera icon next to the address bar, allow the microphone, then tap the mic again.", micNone: "No microphone was found. Plug in or enable a microphone, then tap the mic again. You can keep typing meanwhile.", micBusy: "The microphone is being used by another app or tab. Close it, then tap the mic again.", micUnsupported: "This browser can't use the microphone here. Please try another browser, or keep typing.", micLost: "The microphone was disconnected, so voice stopped. Reconnect it and tap the mic to start again.", micAsk: "Allow the microphone in your browser to start voice…", voiceConnectFail: "Could not connect to voice. Please try again.", voiceDisconnected: "Voice disconnected. Tap the mic to reconnect.", voiceStartFail: "Unable to start voice. Please try again.", voiceStopped: "Voice stopped.", teamOn: "A team member is on this chat", voiceStillHere: "Still in your chat — tap the mic to continue talking.", voiceReconnecting: "Reconnecting voice…", videoTag: "VIDEO", aiDown: "I'm having a little trouble connecting right now. Your cart is still here; please try again in a moment.", noReply: "I couldn't write a reply just now. Please try again.", untitled: "Product", theProduct: "The product",
      },
      hi: {
        today: "आज",
        defaultGreeting: "नमस्ते! {shop} में आपका स्वागत है। आज आप क्या ढूँढ रहे हैं?", defaultGreetingNoShop: "नमस्ते! आज आप क्या ढूँढ रहे हैं?",
        ckCheckout: "चेकआउट", ckReview: "ऑर्डर की समीक्षा", ckSubtotal: "सबटोटल", ckTotal: "कुल", ckFinal: "अंतिम देय राशि",
        ckTotalTax: "कुल ({cur}, टैक्स सहित)", ckTotalCur: "कुल ({cur})", ckFree: "मुफ़्त", ckShipping: "शिपिंग", ckShipMethod: "शिपिंग का तरीका",
        ckDelivery: "डिलीवरी का पता", ckBilling: "बिलिंग का पता", ckSameShip: "शिपिंग पते जैसा ही",
        ckShipSaved: "शिपिंग का पता सहेजा गया", ckBillSaved: "बिलिंग का पता सहेजा गया", ckQty: "मात्रा {n}", ckOrig: "मूल कीमत", ckOrigShort: "मूल", ckDiscounted: "छूट के बाद", ckCartSub: "कार्ट सबटोटल", ckAfterDisc: "छूट के बाद सबटोटल (टैक्स और शिपिंग ऑर्डर रिव्यू में जुड़ते हैं)", ckCoupon: "कूपन लगा",
        ckCouponApplied: "कूपन लागू ({label})", ckCoupon: "कूपन छूट", ckPromo: "प्रोमो छूट", ckDiscApplied: "छूट लागू", ckSavings: "कुल बचत",
        ckTax: "टैक्स", ckTaxIncl: "टैक्स – कीमत में शामिल", ckInclShort: "कीमत में शामिल", ckOtherTax: "अन्य टैक्स/शुल्क (Shopify ने अलग नहीं दिखाए)", ckDuties: "शुल्क और अन्य चार्ज",
        ckPriceNotice: "इस जगह के लिए Shopify इन आइटम की कीमत {shop} लगाता है (स्टोरफ्रंट कार्ट: {store})",
        ckPrepaidOffer: "प्रीपेड ऑफ़र: ऑनलाइन भुगतान पर {save} बचाएँ (सिर्फ़ {pay} दें)!", ckCod: "कैश ऑन डिलीवरी", ckPrepaid: "प्रीपेड (ऑनलाइन भुगतान)",
        ckPayOnline: "ऑनलाइन भुगतान (प्रीपेड)", ckPayOnlineSave: "ऑनलाइन भुगतान ({save} बचाएँ)",
        ckMsgCod: "मैं कैश ऑन डिलीवरी से भुगतान करूँगा", ckMsgPrepaid: "मैं ऑनलाइन (प्रीपेड) भुगतान करूँगा", ckMsgPrepaidSave: "मैं ऑनलाइन (प्रीपेड) भुगतान करूँगा और {save} की छूट लूँगा",
        ckPlaced: "ऑर्डर सफलतापूर्वक हो गया!", ckOrderId: "ऑर्डर आईडी", ckPayment: "भुगतान", ckEmailSent: "पुष्टि ईमेल {email} पर भेजा गया",

        clearChat: "चैट साफ़ करें", clearTitle: "यह चैट साफ़ करें?",
        clearBody: "इससे बातचीत आपकी स्क्रीन से हट जाएगी। स्टोर के पास एक कॉपी रहती है ताकि ज़रूरत पड़ने पर टीम आपकी मदद कर सके। आपका कार्ट नहीं बदलेगा।",
        cancel: "रद्द करें", clearConfirm: "चैट साफ़ करें", cleared: "चैट साफ़ हो गई",
        connected: "जुड़े हुए", endCall: "कॉल खत्म करें", mute: "म्यूट", unmute: "अनम्यूट",
        micOn: "माइक चालू", micPaused: "माइक रुका है", micMuted: "माइक म्यूट",
        lblListen: "सुन रही हूँ…", lblYou: "आप बोल रहे हैं", lblThink: "सोच रही हूँ…", lblSpeak: "बोल रही हूँ", lblMuted: "माइक म्यूट है", lblConnecting: "जुड़ रहा है…",
        subListen: "बस बोलिए। माइक दबाने की ज़रूरत नहीं।", subThink: "सोचते समय माइक रुका रहता है।", subSpeak: "कभी भी बोलकर मुझे रोक सकते हैं।", subMuted: "अनम्यूट करके बोलिए।",
        ph: "कुछ भी पूछिए…", phListen: "आपकी आवाज़ सुन रही हूँ…", phFiles: "संदेश जोड़ें, या सीधे भेजें…",
        teaser: ["कुछ ढूंढने में मदद चाहिए?", "प्रोडक्ट, ऑर्डर या डिलीवरी के बारे में पूछिए", "चैट या बात करने के लिए टैप करें"],
        tBack: "जहाँ छोड़ा था वहीं से शुरू करें", liveWait: "आपका जवाब तैयार हो रहा है…",
        attached: "{max} में से {n} जुड़ी", tooMany: "आप अधिकतम {max} फ़ाइलें जोड़ सकते हैं।", tooBig: "{name} बहुत बड़ी है।", badType: "{name} समर्थित नहीं है।",
        findSimilar: "मिलता-जुलता खोजें", findSimilarMsg: "मेरी फोटो जैसे प्रोडक्ट दिखाइए", uploadFail: "फ़ाइलें अपलोड नहीं हो सकीं। कृपया फिर कोशिश करें।", sendingFiles: "आपकी फ़ाइलें भेज रहा हूँ…",
        busy: "अभी बहुत सारे संदेश आ रहे हैं। कृपया थोड़ा रुककर फिर कोशिश करें।", voiceBusy: "अभी वॉइस व्यस्त है। एक मिनट बाद फिर कोशिश करें, या यहीं चैट करते रहें।", uploadFull: "यह स्टोर अभी और फ़ाइलें नहीं ले सकता। कृपया शब्दों में बताइए।", uploadCheck: "फ़ाइलें अभी जाँची नहीं जा सकतीं। कृपया बाद में फिर कोशिश करें।", connectFail: "माफ़ कीजिए, शॉपिंग असिस्टेंट से जुड़ नहीं पाया। कृपया फिर कोशिश करें।", emptyMsg: "कृपया कुछ शब्दों वाला संदेश लिखें।", lostReply: "आपके पिछले संदेश का जवाब देने से पहले पेज रीलोड हो गया।", chatTimeout: "इसमें उम्मीद से ज़्यादा समय लग रहा है, इसलिए मैंने इंतज़ार बंद कर दिया। आपका संदेश सुरक्षित है: आप फिर कोशिश कर सकते हैं।", retry: "फिर कोशिश करें",
        openAria: "Orbi AI शॉपिंग असिस्टेंट खोलें", minAria: "चैट छोटी करें", closeAria: "चैट बंद करें", menuAria: "और विकल्प",
        attachAria: "फोटो, वीडियो या PDF जोड़ें", removeAll: "सब हटाएँ", removeOne: "हटाएँ", dismiss: "बंद करें",
        micStart: "माइक चालू करें", micStop: "माइक बंद करें",
        adding: "जोड़ रही हूँ…", proceedCheckout: "चेकआउट पर जाएँ →", cartAddFail: "Shopify यह प्रोडक्ट कार्ट में नहीं जोड़ पाया।", pickVariant: "पहले इस प्रोडक्ट का एक विकल्प (जैसे साइज़ या रंग) चुनें, फिर मैं इसे जोड़ दूँगी।", cartLineFail: "कार्ट की यह लाइन अपडेट नहीं हो सकी। कृपया कार्ट पेज से कोशिश करें।", cartUpdateFail: "कार्ट अपडेट नहीं हो सका। कृपया फिर कोशिश करें।", voiceReceiving: "आवाज़ आ रही है…", voiceError: "वॉइस में दिक्कत आई। कृपया फिर कोशिश करें।", setupNeeded: "स्टोर अभी यह चैट सेट कर रहा है। कृपया बाद में कोशिश करें।", voiceHttps: "वॉइस के लिए सुरक्षित कनेक्शन चाहिए। कृपया टेक्स्ट चैट इस्तेमाल करें।", voiceConnecting: "वॉइस जुड़ रही है…", voiceUnavailable: "अभी वॉइस उपलब्ध नहीं है। कृपया टेक्स्ट चैट इस्तेमाल करें।", voiceConnected: "वॉइस जुड़ गई। सुन रही हूँ…", micFail: "माइक्रोफ़ोन शुरू नहीं हो सका। कृपया माइक की अनुमति दें और फिर कोशिश करें।", micDenied: "इस साइट के लिए माइक्रोफ़ोन की अनुमति बंद है। एड्रेस बार के पास लॉक आइकन पर क्लिक करके माइक की अनुमति दें, फिर माइक दोबारा दबाएँ।", micNone: "कोई माइक्रोफ़ोन नहीं मिला। माइक लगाएँ या चालू करें, फिर माइक दोबारा दबाएँ। तब तक आप टाइप कर सकते हैं।", micBusy: "माइक्रोफ़ोन किसी दूसरे ऐप या टैब में इस्तेमाल हो रहा है। उसे बंद करें, फिर माइक दोबारा दबाएँ।", micUnsupported: "यह ब्राउज़र यहाँ माइक्रोफ़ोन इस्तेमाल नहीं कर सकता। कृपया दूसरा ब्राउज़र आज़माएँ, या टाइप करें।", micLost: "माइक्रोफ़ोन अलग हो गया, इसलिए वॉइस बंद हो गई। उसे दोबारा जोड़ें और माइक दबाएँ।", micAsk: "वॉइस शुरू करने के लिए ब्राउज़र में माइक की अनुमति दें…", voiceConnectFail: "वॉइस से जुड़ नहीं पाई। कृपया फिर कोशिश करें।", voiceDisconnected: "वॉइस कट गई। दोबारा जुड़ने के लिए माइक दबाएँ।", voiceStartFail: "वॉइस शुरू नहीं हो सकी। कृपया फिर कोशिश करें।", voiceStopped: "वॉइस बंद हुई।", teamOn: "स्टोर की टीम का एक सदस्य इस चैट पर है", voiceStillHere: "आप अभी भी चैट में हैं — बात जारी रखने के लिए माइक दबाएँ।", voiceReconnecting: "वॉइस फिर से जुड़ रही है…", videoTag: "वीडियो", aiDown: "अभी जुड़ने में थोड़ी दिक्कत आ रही है। आपका कार्ट सुरक्षित है; कृपया थोड़ी देर में फिर कोशिश करें।", noReply: "अभी जवाब नहीं लिख पाई। कृपया फिर कोशिश करें।", untitled: "प्रोडक्ट", theProduct: "यह प्रोडक्ट",
      },
    };
    // Roman-letter Hindi ("Hinglish"): the chat's own labels follow the shopper's last few messages when no language was chosen,
    // so a shopper writing "mujhe bag dikhao" does not get "Thinking…", "Retry" and "Order Review" in English. Anything without a
    // Hinglish label falls back to English.
    const HINGLISH_WORDS = /\b(?:hai|hain|hoon|kya|mujhe|mera|meri|mere|chahiye|karo|karna|kar\s+do|dikhao|batao|nahi|haan|yaar|bhai|wala|wali|abhi|bhi|aur|baat|insaan|rehne|kaise|kitna|kitne|accha|acha|theek|thik)\b/gi;
    const chatIsHinglish = () => {
      const recent = chatHistory.filter((h) => h && h.role === "user").slice(-3).map((h) => String(h.content || "")).join(" ");
      if (/[\u0900-\u097F]/.test(recent)) return false;
      return (recent.match(HINGLISH_WORDS) || []).length >= 2;
    };
    const uiLang = () => (preferredLanguage === "hi" ? "hi" : preferredLanguage === "hinglish" ? "hinglish" : preferredLanguage === "en" ? "en" : chatIsHinglish() ? "hinglish" : "en");
    UI.hinglish = {
      today: "Aaj",
      ckCheckout: "Checkout", ckReview: "Order Review", ckSubtotal: "Subtotal", ckTotal: "Total", ckFinal: "Final payable total",
      ckTotalTax: "Total ({cur}, tax ke saath)", ckTotalCur: "Total ({cur})", ckFree: "FREE", ckShipping: "Shipping", ckShipMethod: "Shipping method",
      ckDelivery: "Delivery address", ckBilling: "Billing address", ckSameShip: "Delivery address jaisa hi",
      ckShipSaved: "Delivery address save ho gaya", ckBillSaved: "Billing address save ho gaya", ckQty: "Qty {n}",
      ckTax: "Tax", ckTaxIncl: "Tax – price mein shamil", ckInclShort: "price mein shamil", ckOtherTax: "Baaki tax/duty (Shopify ne alag se nahi likha)", ckDuties: "Duty aur baaki charges",
      ckCod: "Cash on Delivery", ckPrepaid: "Prepaid (online payment)", ckPayOnline: "Online pay karo (Prepaid)", ckPayOnlineSave: "Online pay karo ({save} bachao)",
      ckMsgCod: "Cash on Delivery se pay karna hai", ckMsgPrepaid: "Online (prepaid) pay karna hai", ckMsgPrepaidSave: "Online (prepaid) pay karke {save} bachana hai",
      ckPlaced: "Order place ho gaya!", ckOrderId: "Order ID", ckPayment: "Payment", ckEmailSent: "Confirmation email {email} par bhej di gayi",
      clearChat: "Chat clear karo", clearTitle: "Ye chat clear karein?",
      clearBody: "Isse chat aapki screen se hat jaayegi. Store ke paas ek copy rahegi taaki zarurat padne par team madad kar sake. Aapka cart waisa hi rahega.",
      cancel: "Cancel", clearConfirm: "Chat clear karo", cleared: "Chat clear ho gayi",
      lblListen: "Sun rahi hoon…", lblYou: "Aap bol rahe hain", lblThink: "Soch rahi hoon…", lblSpeak: "Bol rahi hoon", lblMuted: "Mic mute hai", lblConnecting: "Jud rahi hoon…",
      subListen: "Bas boliye, mic dabane ki zarurat nahi.", subThink: "Jab tak main soch rahi hoon, mic ruka hai.", subSpeak: "Beech mein kabhi bhi bol kar rok sakte hain.", subMuted: "Unmute karke boliye.",
      ph: "Kuch bhi poochiye…", phListen: "Aapki awaaz sun rahi hoon…", phFiles: "Message likhiye, ya seedha bhej dijiye…",
      liveWait: "Jawab taiyaar kar rahi hoon…", retry: "Dobara try karo",
      lostReply: "Aapke pichhle message ka jawab aane se pehle page reload ho gaya.",
      chatTimeout: "Isme umeed se zyada time lag raha hai, isliye maine wait karna band kar diya. Aapka message safe hai, dobara try kar sakte hain.",
      noReply: "Abhi jawab nahi likh paayi. Dobara try kijiye.",
      pickVariant: "Pehle is product ka ek option (jaise size ya colour) chun lijiye, phir main add kar deti hoon.",
      aiDown: "Abhi connect hone mein thodi dikkat aa rahi hai. Aapka cart safe hai, thodi der mein dobara try kijiye.",
      busy: "Abhi bahut saare messages aa rahe hain. Thoda ruk kar dobara try kijiye.",
      adding: "Add kar rahi hoon…", proceedCheckout: "Checkout par chalo →",
      cartAddFail: "Shopify ye product cart mein add nahi kar paaya.", cartUpdateFail: "Cart update nahi ho paaya. Dobara try kijiye.",
      voiceConnecting: "Voice jud rahi hai…", voiceConnected: "Voice jud gayi. Sun rahi hoon…", voiceStopped: "Voice band ho gayi.",
      voiceUnavailable: "Abhi voice available nahi hai. Text chat use kijiye.", voiceDisconnected: "Voice kat gayi. Dobara judne ke liye mic dabaiye.",
      micDenied: "Is site ke liye mic ki permission band hai. Address bar ke paas lock icon par click karke mic allow kijiye, phir mic dobara dabaiye.",
      micNone: "Koi microphone nahi mila. Mic lagaiye ya on kijiye, phir mic dobara dabaiye. Tab tak type kar sakte hain.",
      emptyMsg: "Kuch shabdon wala message likhiye.",
    };
    // the "thinking" placeholder bubble, in whichever language it was shown
    const isThinkingText = (text) => Object.values(UI).some((t) => t.lblThink === text);
    const ui = (key, vars) => {
      let text = (UI[uiLang()] && UI[uiLang()][key]) ?? UI.en[key] ?? "";
      if (vars && typeof text === "string") for (const k of Object.keys(vars)) text = text.split(`{${k}}`).join(String(vars[k]));
      return text;
    };
    let lastChips = [];

    function applyUiLang() {
      root.querySelectorAll("[data-i18n]").forEach((el) => {
        const value = ui(el.dataset.i18n);
        if (value) el.textContent = value;
      });
      const aria = (el, key) => {
        if (!el) return;
        el.setAttribute("aria-label", ui(key));
        if (el.hasAttribute("title")) el.setAttribute("title", ui(key));
      };
      aria(toggle, "openAria");
      aria(minimizeBtn, "minAria");
      aria(close, "closeAria");
      aria(menuBtn, "menuAria");
      aria(attachBtn, "attachAria");
      aria(voiceAttach, "attachAria");
      aria(trayClear, "removeAll");
      aria(teaserClose, "dismiss");
      if (input) input.placeholder = placeholderText();
      if (mic) {
        const active = mic.classList.contains("is-listening") || mic.classList.contains("is-connecting");
        aria(mic, active ? "micStop" : "micStart");
      }
      renderTray();
      renderChips(lastChips);
      syncVoiceStrip();
    }

    function placeholderText() {
      if (isVoiceListening || isVoiceConnecting) return isMicMuted ? ui("subMuted") : ui("phListen");
      return files.length ? ui("phFiles") : ui("ph");
    }

    // ---- Call strip: connection, timer, mic state, flowing waves, mute and end call. ----
    // The mic stays on for the whole call. Thinking pauses it; the shopper can interrupt while the agent speaks.
    const USER_TALKING_HOLD_MS = 600;
    let userTalkingUntil = 0;
    let userTalkingShown = false;
    const isUserTalking = () => Date.now() < userTalkingUntil;
    let isMicMuted = false;
    let liveMicLevel = 0.35;
    let callStartedAt = 0;
    let callTicker = null;
    let waveFrame = null;
    let waveLevel = 0;
    let pendingReply = false;
    // Bumped whenever the conversation is cleared: a reply that arrives for an older conversation is dropped, never drawn into the new one.
    let chatEpoch = 0;
    let replyInFlight = false;
    let stoppedByShopper = false;
    let stopCurrentReply = null;
    let lastSentText = "";
    let lastSentAt = 0;
    let voiceStartSeq = 0;
    // How many turns of the conversation the browser keeps and sends back. One number for text, voice sync and saved state
    // (it used to be 6 in one place and 8 in another, and the server only ever saw part of it). The server also keeps its own ordered
    // record of the products it showed, so this window does not have to carry the whole chat.
    const HISTORY_KEEP = 12;
    const chatTimeoutMs = () => {
      const override = Number(window.__orbiChatTimeoutMs);
      return Number.isFinite(override) && override > 0 ? override : 75000;
    };
    const waveCtx = voiceWave && voiceWave.getContext ? voiceWave.getContext("2d") : null;

    function voiceState() {
      if (isMicMuted) return "muted";
      const t = ((status && status.textContent) || "").toLowerCase();
      if (isThinking || t.includes("processing") || t.includes("thinking")) return "thinking";
      if (isSpeakingResponse || t.includes("speaking") || t.includes("receiving audio")) return "speaking";
      return "listening";
    }

    function callClock() {
      const sec = callStartedAt ? Math.floor((Date.now() - callStartedAt) / 1000) : 0;
      return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
    }

    function drawWave(ts) {
      waveFrame = null;
      if (!waveCtx || !panel || !panel.classList.contains("is-voice-live")) return;
      const w = voiceWave.width;
      const h = voiceWave.height;
      const mid = h / 2;
      const state = voiceState();
      const goal = state === "listening" ? Math.min(1, liveMicLevel * 1.4 + (isUserTalking() ? 0.35 : 0)) : state === "speaking" ? 0.55 : 0.2;
      waveLevel += (goal - waveLevel) * 0.1;
      const amp = state === "muted" ? 0.02 : state === "thinking" ? 0.16 + 0.05 * Math.sin(ts / 420) : state === "speaking" ? 0.4 + 0.2 * Math.sin(ts / 230) * Math.cos(ts / 610) : 0.18 + waveLevel * 0.7;
      const speed = state === "speaking" ? 260 : state === "thinking" ? 620 : 420;
      const grad = waveCtx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, "#6366f1");
      grad.addColorStop(0.55, "#a855f7");
      grad.addColorStop(1, "#ec4899");
      waveCtx.clearRect(0, 0, w, h);
      waveCtx.lineCap = "round";
      waveCtx.lineJoin = "round";
      [{ f: 1.5, a: 1, p: 0, al: 1, lw: 3 }, { f: 2.1, a: 0.72, p: 1.7, al: 0.55, lw: 2.2 }, { f: 2.9, a: 0.5, p: 3.1, al: 0.35, lw: 1.6 }].forEach((layer) => {
        waveCtx.beginPath();
        for (let x = 0; x <= w; x += 4) {
          const t = x / w;
          const env = Math.pow(Math.sin(Math.PI * t), 1.4);
          const y = mid + Math.sin(t * Math.PI * 2 * layer.f * 1.6 + (ts / speed) * (layer.f > 2 ? -1 : 1) + layer.p) * (mid - 6) * Math.min(1, amp) * layer.a * env;
          if (x === 0) waveCtx.moveTo(x, y);
          else waveCtx.lineTo(x, y);
        }
        waveCtx.globalAlpha = layer.al;
        waveCtx.strokeStyle = grad;
        waveCtx.lineWidth = layer.lw;
        waveCtx.stroke();
      });
      waveCtx.globalAlpha = 1;
      waveFrame = window.requestAnimationFrame(drawWave);
    }

    function ensureWave() {
      if (waveFrame || !waveCtx || !panel || !panel.classList.contains("is-voice-live")) return;
      waveFrame = window.requestAnimationFrame(drawWave);
    }

    function syncVoiceStrip() {
      const state = voiceState();
      const connecting = isVoiceConnecting && !isVoiceListening;
      if (voiceStrip) {
        voiceStrip.dataset.voiceState = state;
        voiceStrip.classList.toggle("is-muted", state === "muted");
        voiceStrip.classList.toggle("is-speaking", state === "speaking");
        voiceStrip.classList.toggle("is-thinking", state === "thinking");
      }
      if (voiceCenterMic) {
        const label = isMicMuted ? ui("unmute") : ui("mute");
        voiceCenterMic.innerHTML = `${isMicMuted ? STOP_ICON : MIC_ICON}<span>${label}</span>`;
        voiceCenterMic.setAttribute("aria-pressed", String(isMicMuted));
        voiceCenterMic.setAttribute("aria-label", label);
        voiceCenterMic.setAttribute("title", label);
      }
      if (voiceMicPill) {
        const key = state === "muted" ? "micMuted" : state === "thinking" ? "micPaused" : "micOn";
        voiceMicPill.dataset.s = state === "muted" ? "muted" : state === "thinking" ? "paused" : "on";
        voiceMicPill.textContent = ui(key);
      }
      if (voiceLabel) {
        voiceLabel.textContent = connecting
          ? ui("lblConnecting")
          : state === "muted" ? ui("lblMuted")
          : state === "thinking" ? ui("lblThink")
          : state === "speaking" ? ui("lblSpeak")
          : isUserTalking() ? ui("lblYou") : ui("lblListen");
      }
      if (voiceCaption) {
        voiceCaption.textContent = state === "muted" ? ui("subMuted") : state === "thinking" ? ui("subThink") : state === "speaking" ? ui("subSpeak") : ui("subListen");
      }
      if (voiceTimer) voiceTimer.textContent = callClock();
      ensureWave();
      refreshLive();
    }

    function startCallClock() {
      if (!callStartedAt) callStartedAt = Date.now();
      if (!callTicker) callTicker = window.setInterval(syncVoiceStrip, 1000);
    }

    function stopCallClock() {
      callStartedAt = 0;
      if (callTicker) window.clearInterval(callTicker);
      callTicker = null;
      isMicMuted = false;
    }

    if (languageSelect) {
      languageSelect.value = preferredLanguage;
      languageSelect.addEventListener("change", () => setPreferredLanguage(languageSelect.value, { fromMenu: true }));
    }

    function setMicMuted(muted) {
      isMicMuted = Boolean(muted);
      setMicTrackEnabled(!isMicMuted);
      // drop anything captured but not yet sent, and any half-detected barge-in
      voiceBuffer = [];
      voiceBufferLength = 0;
      recentSpeech.length = 0;
      bargeInHits = 0;
      if (status && isVoiceListening && !isSpeakingResponse && !isThinking) {
        status.textContent = isMicMuted ? "Mic muted" : "Listening…";
      }
      if (input) input.placeholder = placeholderText();
      syncVoiceStrip();
    }

    if (voiceCenterMic) {
      voiceCenterMic.addEventListener("click", () => {
        if (!isVoiceListening && !isVoiceConnecting) return;
        setMicMuted(!isMicMuted);
      });
    }

    if (voiceEnd) {
      voiceEnd.addEventListener("click", () => {
        stopVoice({ userInitiated: true });
        if (status) status.textContent = "";
      });
    }

    if (status && voiceStrip && typeof MutationObserver !== "undefined") {
      new MutationObserver(syncVoiceStrip).observe(status, { childList: true, characterData: true, subtree: true });
    }

    // ---- Robot launcher: running indicator and the rotating help bubble while the panel is away. ----
    let unreadCount = 0;
    let teaserTimer = null;
    let teaserShowTimer = null;
    let teaserIndex = 0;
    let teaserDismissed = false;
    let teaserWasLive = false;
    try { teaserDismissed = sessionStorage.getItem(`${storageKey}_teaser`) === "0"; } catch {}

    const panelAway = () => Boolean(panel && (panel.hidden || isMinimized || panel.classList.contains("is-minimized")));
    const hasConversation = () => Boolean(messages && messages.querySelector(".ai-commerce-chat-user"));

    function liveInfo() {
      if (!panelAway()) return null;
      if (isVoiceListening || isVoiceConnecting) {
        const state = voiceState();
        const label = state === "muted" ? ui("micMuted") : state === "thinking" ? ui("lblThink") : state === "speaking" ? ui("lblSpeak") : ui("lblListen");
        return { state: state === "muted" ? "listening" : state, text: `${label} · ${callClock()}` };
      }
      if (pendingReply) return { state: "thinking", text: ui("liveWait") };
      return null;
    }

    function paintTeaser(animate) {
      if (!teaser || !teaserText) return;
      const live = liveInfo();
      const messagesList = ui("teaser");
      const resume = hasConversation();
      const apply = () => {
        const current = liveInfo();
        teaserText.textContent = current ? current.text : resume ? ui("tBack") : messagesList[teaserIndex % messagesList.length];
        if (teaserDots) {
          teaserDots.style.display = current || resume ? "none" : "flex";
          Array.from(teaserDots.children).forEach((dot, i) => dot.classList.toggle("on", i === teaserIndex % messagesList.length));
        }
        teaserText.classList.remove("is-out");
      };
      if (animate && !live) {
        teaserText.classList.add("is-out");
        window.setTimeout(apply, 220);
      } else apply();
    }

    function stopTeaser() {
      window.clearInterval(teaserTimer);
      window.clearTimeout(teaserShowTimer);
      teaserTimer = null;
      if (teaser) teaser.hidden = true;
    }

    function startTeaser(delay) {
      window.clearTimeout(teaserShowTimer);
      teaserShowTimer = window.setTimeout(() => {
        if (!teaser || teaserDismissed || !panelAway()) return;
        teaserIndex = 0;
        paintTeaser(false);
        teaser.hidden = false;
        window.clearInterval(teaserTimer);
        teaserTimer = window.setInterval(() => {
          if (!panelAway() || hasConversation() || liveInfo()) return;
          teaserIndex = (teaserIndex + 1) % ui("teaser").length;
          paintTeaser(true);
        }, 4200);
      }, delay);
    }

    function refreshLive() {
      if (!toggle) return;
      const live = liveInfo();
      if (live) {
        toggle.dataset.live = live.state;
        teaserWasLive = true;
        window.clearInterval(teaserTimer);
        window.clearTimeout(teaserShowTimer);
        teaserTimer = null;
        if (teaser) teaser.hidden = false;
        paintTeaser(false);
      } else {
        toggle.removeAttribute("data-live");
        if (!panelAway()) {
          stopTeaser();
        } else if (teaserWasLive) {
          teaserWasLive = false;
          stopTeaser();
          startTeaser(1400);
        }
      }
      if (unreadBadge) {
        unreadBadge.hidden = !(unreadCount > 0 && panelAway());
        unreadBadge.textContent = String(unreadCount);
      }
    }

    function noteUnread() {
      if (!panelAway()) return;
      unreadCount += 1;
      refreshLive();
    }

    function clearUnread() {
      unreadCount = 0;
      refreshLive();
    }

    if (teaserClose) {
      teaserClose.addEventListener("click", (event) => {
        event.stopPropagation();
        teaserDismissed = true;
        try { sessionStorage.setItem(`${storageKey}_teaser`, "0"); } catch {}
        stopTeaser();
      });
    }
    if (teaser) teaser.addEventListener("click", () => toggle.click());

    function setMicState(state) {
      if (!mic) return;

      const listening = state === "listening";
      const active = listening || state === "connecting";
      if (active) startCallClock();
      else stopCallClock();

      mic.classList.toggle("is-listening", listening);
      mic.classList.toggle("is-connecting", state === "connecting");
      mic.innerHTML = active ? STOP_ICON : MIC_ICON;
      mic.setAttribute("aria-label", ui(active ? "micStop" : "micStart"));
      mic.setAttribute("title", ui(active ? "micStop" : "micStart"));
      mic.setAttribute("aria-pressed", String(listening));
      panel.classList.toggle("is-voice-live", active);
      if (input) input.placeholder = placeholderText();
      syncVoiceStrip();
    }

    async function refreshCartCount() {
      if (!cartCount) return;

      try {
        const response = await fetch(cartUrl("cart.js"), {
          headers: { Accept: "application/json" },
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) return;

        const cart = await response.json();
        const count = Number(cart.item_count) || 0;

        cartCount.textContent = count > 9 ? "9+" : String(count);
        cartCount.hidden = count === 0;
      } catch {
        // Cart badge is cosmetic; ignore network errors.
      }
    }

    function uiStateKey(suffix) {
      return storageKey + "_" + suffix;
    }

    function writeFlagCookie(name, value) {
      try {
        document.cookie = `${name}=${value}; path=/; max-age=86400; SameSite=Lax`;
      } catch {}
    }

    function readFlagCookie(name) {
      try {
        const match = document.cookie.match(
          new RegExp("(?:^|; )" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)")
        );
        return match ? decodeURIComponent(match[1]) : "";
      } catch {
        return "";
      }
    }

    function settleAway() {
      if (!panelAway()) {
        clearUnread();
        stopTeaser();
        return;
      }
      refreshLive();
      if (!liveInfo() && !teaserDismissed && teaser && teaser.hidden) startTeaser(2500);
    }

    function persistUiState() {
      settleAway();
      if (restoringState) return;
      try {
        let open = panel && !panel.hidden;
        if (pageLeaving && readUiFlag("open")) open = true;
        localStorage.setItem(uiStateKey("open"), open ? "1" : "0");
        localStorage.setItem(uiStateKey("minimized"), isMinimized ? "1" : "0");
        sessionStorage.setItem(uiStateKey("open"), open ? "1" : "0");
        sessionStorage.setItem(uiStateKey("minimized"), isMinimized ? "1" : "0");
        writeFlagCookie(uiStateKey("open"), open ? "1" : "0");
        if (isVoiceListening) {
          localStorage.setItem(uiStateKey("voice"), String(Date.now()));
        }
      } catch {}
    }

    function readUiFlag(suffix) {
      try {
        const fromLocal = localStorage.getItem(uiStateKey(suffix));
        if (fromLocal === "1" || fromLocal === "0") return fromLocal === "1";
        const fromSession = sessionStorage.getItem(uiStateKey(suffix));
        if (fromSession === "1" || fromSession === "0") return fromSession === "1";
        const fromCookie = readFlagCookie(uiStateKey(suffix));
        if (fromCookie === "1" || fromCookie === "0") return fromCookie === "1";
      } catch {}
      return false;
    }

    function restoreUiState() {
      try {
        const wasOpen = readUiFlag("open");
        if (readUiFlag("minimized")) {
          isMinimized = true;
          panel.classList.add("is-minimized");
        }
        if (wasOpen) {
          panel.hidden = false;
          panel.removeAttribute("hidden");
          toggle.setAttribute("aria-expanded", "true");
          if (isMinimized) toggle.setAttribute("aria-expanded", "false");
          void refreshCartCount();
        }
      } catch {}
    }

    let closeAnimTimer = null;

    function setOpen(open) {
      if (closeAnimTimer) {
        clearTimeout(closeAnimTimer);
        closeAnimTimer = null;
      }
      if (open) {
        isMinimized = false;
        panel.classList.remove("is-minimized", "is-closing");
        panel.hidden = false;
        panel.removeAttribute("hidden");
        panel.classList.remove("is-opening");
        void panel.offsetWidth;
        panel.classList.add("is-opening");
        toggle.setAttribute("aria-expanded", "true");
        if (chatIsEmpty()) void showOpeningMessage();
        input.focus();
        void refreshCartCount();
        persistUiState();
      } else {
        toggle.setAttribute("aria-expanded", "false");
        closeMenu();
        if (typeof stopVoice === "function") {
          try {
            stopVoice({ userInitiated: true });
          } catch {}
        }
        try {
          localStorage.setItem(uiStateKey("open"), "0");
          sessionStorage.setItem(uiStateKey("open"), "0");
          writeFlagCookie(uiStateKey("open"), "0");
        } catch {}
        panel.classList.remove("is-opening");
        panel.classList.add("is-closing");
        closeAnimTimer = setTimeout(() => {
          panel.classList.remove("is-closing");
          panel.hidden = true;
          closeAnimTimer = null;
          persistUiState();
        }, 230);
      }
    }

    function setMinimized(minimized) {
      if (closeAnimTimer) {
        clearTimeout(closeAnimTimer);
        closeAnimTimer = null;
      }
      isMinimized = !!minimized;
      toggle.setAttribute("aria-expanded", isMinimized ? "false" : "true");
      settleAway();
      if (isMinimized) {
        panel.classList.remove("is-opening");
        closeMenu();
        try {
          localStorage.setItem(uiStateKey("minimized"), "1");
          sessionStorage.setItem(uiStateKey("minimized"), "1");
        } catch {}
        panel.classList.add("is-closing");
        closeAnimTimer = setTimeout(() => {
          panel.classList.remove("is-closing");
          panel.classList.add("is-minimized");
          closeAnimTimer = null;
          persistUiState();
        }, 230);
      } else {
        panel.classList.remove("is-minimized", "is-closing");
        panel.classList.remove("is-opening");
        void panel.offsetWidth;
        panel.classList.add("is-opening");
        try {
          localStorage.setItem(uiStateKey("minimized"), "0");
          sessionStorage.setItem(uiStateKey("minimized"), "0");
        } catch {}
        persistUiState();
      }
    }

    function closeMenu() {
      if (!menuPanel || !menuBtn) return;
      menuPanel.hidden = true;
      menuBtn.setAttribute("aria-expanded", "false");
    }

    function toggleMenu() {
      if (!menuPanel || !menuBtn) return;
      const open = menuPanel.hidden;
      menuPanel.hidden = !open;
      menuBtn.setAttribute("aria-expanded", String(open));
    }

    function resetConversation() {
      closeMenu();
      chatEpoch += 1;
      exitThinkingMode();
      interruptAssistant();
      chatHistory.length = 0;
      displayedProducts = [];
      checkoutState = null;
      lastMessageAt = 0;
      voiceGreetingDone = false;
      setMinimized(false);
      try {
        localStorage.removeItem(storageKey);
      } catch {}
      notifyServerChatCleared(true);
      messages.innerHTML = "";
      ensureWelcomeBanner();
      openingMessagePromise = null;
      openingMessageShown = null;
      openingSpokenText = "";
      void showOpeningMessage();
      if (status) status.textContent = "";
      persistUiState();
      input.focus();
    }

    
    function isMessagesNearBottom(thresholdPx = 120) {
      if (!messages) return true;
      const gap = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
      return gap <= thresholdPx;
    }

    // Whether the shopper is following the bottom of the chat. It is remembered from the last time they scrolled
    // (or the chat was scrolled for them), NOT measured after a new message or product grid is added: a tall
    // grid makes the gap larger than the threshold at once, and the reply would stay below the fold.
    var lastAgentReplyEl = null; // the assistant's latest reply bubble: marked when the cart change it announced did not happen
    var followingBottom = true; // var: safeScrollMessagesToBottom can run before this line during start-up
    if (messages) {
      messages.addEventListener("scroll", () => { followingBottom = isMessagesNearBottom(); }, { passive: true });
      // product photos finish loading after the grid is added and make the chat taller
      messages.addEventListener("load", () => { if (followingBottom) messages.scrollTop = messages.scrollHeight; }, true);
    }

    function safeScrollMessagesToBottom(force = false) {
      if (!messages) return;
      if (force || followingBottom) {
        messages.scrollTop = messages.scrollHeight;
        followingBottom = true;
      }
    }

    // Inline markup: **bold** and [label](https://link). Only http(s) links become anchors; anything else stays plain text.
    function appendInlineBold(parent, text) {
      const parts = String(text || "").split(/(\*\*[^*]+\*\*|\[[^\]]+\]\(\s*https?:\/\/[^\s)]+\s*\))/g);
      parts.forEach((part) => {
        if (!part) return;
        const link = part.match(/^\[([^\]]+)\]\(\s*(https?:\/\/[^\s)]+)\s*\)$/);
        if (link) {
          const a = document.createElement("a");
          a.href = link[2];
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.className = "ai-commerce-inline-link";
          appendInlineBold(a, link[1]);
          parent.appendChild(a);
        } else if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
          const strong = document.createElement("strong");
          strong.textContent = part.slice(2, -2);
          parent.appendChild(strong);
        } else {
          parent.appendChild(document.createTextNode(part));
        }
      });
    }

    function paintFormattedBotSlice(container, sliceText, showCursor = false) {
      container.innerHTML = "";
      const raw = String(sliceText || "").trim();
      if (!raw) {
        if (showCursor) {
          const cur = document.createElement("span");
          cur.className = "ai-commerce-typing-cursor";
          container.appendChild(cur);
        }
        return;
      }

      const normalized = raw
        .replace(/\s+•\s+(?=\*\*)/g, "\n• ")
        .replace(/\s+(\d+[.)])\s+(?=\*\*)/g, "\n$1 ");
      const lines = normalized
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      let currentList = null;
      let currentListTag = null;
      let lastLeaf = null;

      lines.forEach((line) => {
        const numberedMatch = line.match(/^(\d+)[.)]\s+(.*)$/);
        const bulletMatch = line.match(/^[•\-*]\s+(.*)$/);
        if (numberedMatch || bulletMatch) {
          const listTag = numberedMatch ? "ol" : "ul";
          const itemText = numberedMatch ? numberedMatch[2] : bulletMatch[1];
          if (!currentList || currentListTag !== listTag) {
            currentList = document.createElement(listTag);
            currentListTag = listTag;
            currentList.style.margin = "6px 0 8px 18px";
            currentList.style.padding = "0";
            currentList.style.listStyle = listTag === "ol" ? "decimal" : "disc";
            container.appendChild(currentList);
          }
          const li = document.createElement("li");
          li.style.marginBottom = "4px";
          li.style.lineHeight = "1.45";
          appendInlineBold(li, itemText);
          currentList.appendChild(li);
          lastLeaf = li;
        } else {
          currentList = null;
          currentListTag = null;
          const p = document.createElement("p");
          p.style.margin = "0 0 6px 0";
          p.style.lineHeight = "1.45";
          appendInlineBold(p, line);
          container.appendChild(p);
          lastLeaf = p;
        }
      });

      if (showCursor && lastLeaf) {
        const cur = document.createElement("span");
        cur.className = "ai-commerce-typing-cursor";
        lastLeaf.appendChild(cur);
      }
    }

    function renderFormattedBotText(container, text, options = {}) {
      const raw = String(text || "").trim();
      container.dataset.rawText = raw;
      if (container._typewriterTimer) {
        clearInterval(container._typewriterTimer);
        container._typewriterTimer = null;
      }

      // A hidden tab (the shopper switched away) throttles timers to about one tick a minute: the reply is painted whole instead of
      // crawling out word by word, and coming back to the tab finishes any reply still being typed.
      const shouldStream =
        !document.hidden &&
        (options.stream !== undefined
          ? Boolean(options.stream)
          : !restoringState && raw.length > 0 && !isThinkingText(raw));

      if (!shouldStream) {
        paintFormattedBotSlice(container, raw, false);
        return;
      }

      // Stream text progressively at speaking cadence (~18-22 chars/sec, word-aware chunks)
      const tokens = raw.match(/\S+\s*/g) || [raw];
      let tokenIdx = 0;
      let built = "";
      paintFormattedBotSlice(container, "", true);

      // Paced so a typical spoken sentence prints smoothly alongside the agent's voice
      const stepMs = Math.max(42, Math.min(85, Math.round(2800 / Math.max(tokens.length, 8))));

      container._finishTyping = () => {
        if (!container._typewriterTimer) return;
        clearInterval(container._typewriterTimer);
        container._typewriterTimer = null;
        paintFormattedBotSlice(container, raw, false);
      };
      container._typewriterTimer = setInterval(() => {
        if (!container.isConnected) {
          clearInterval(container._typewriterTimer);
          container._typewriterTimer = null;
          return;
        }
        if (document.hidden) {
          container._finishTyping();
          return;
        }
        tokenIdx++;
        built = tokens.slice(0, tokenIdx).join("");
        const done = tokenIdx >= tokens.length;
        paintFormattedBotSlice(container, built, !done);
        safeScrollMessagesToBottom(false);
        if (done) {
          clearInterval(container._typewriterTimer);
          container._typewriterTimer = null;
        }
      }, stepMs);
    }

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) return;
      for (const el of messages.querySelectorAll(".ai-commerce-chat-bot")) if (el._typewriterTimer && el._finishTyping) el._finishTyping();
    });

    function streamUserText(container, text, options = {}) {
      const raw = String(text || "").trim();
      container.dataset.rawText = raw;
      if (container._typewriterTimer) {
        clearInterval(container._typewriterTimer);
        container._typewriterTimer = null;
      }
      const shouldStream = Boolean(options.stream) && !restoringState && raw.length > 0;
      if (!shouldStream) {
        container.textContent = raw;
        return;
      }
      const tokens = raw.match(/\S+\s*/g) || [raw];
      let idx = 0;
      container.textContent = "";
      const cursor = document.createElement("span");
      cursor.className = "ai-commerce-typing-cursor";
      container.appendChild(cursor);

      const stepMs = Math.max(38, Math.min(70, Math.round(900 / Math.max(tokens.length, 4))));
      container._typewriterTimer = setInterval(() => {
        if (!container.isConnected) {
          clearInterval(container._typewriterTimer);
          container._typewriterTimer = null;
          return;
        }
        idx++;
        const slice = tokens.slice(0, idx).join("");
        const done = idx >= tokens.length;
        container.textContent = slice;
        if (!done) {
          container.appendChild(cursor);
        } else {
          clearInterval(container._typewriterTimer);
          container._typewriterTimer = null;
        }
        safeScrollMessagesToBottom(false);
      }, stepMs);
    }

    const firstBotBubble = messages.querySelector(".ai-commerce-chat-bot");
    if (firstBotBubble && !firstBotBubble.dataset.time) {
      firstBotBubble.dataset.time = formatMsgTime();
      firstBotBubble.dataset.rawText = (firstBotBubble.textContent || "").trim();
    }

    // The greeting when the AI has none: the merchant's own (theme editor), else a short default in the visitor's language.
    // The chat never opens empty.
    function fallbackGreeting() {
      if (MERCHANT_GREETING) return MERCHANT_GREETING;
      const shop = String(root.dataset.shopName || "").trim();
      return shop ? ui("defaultGreeting", { shop }) : ui("defaultGreetingNoShop");
    }

    function fetchOpeningMessage() {
      if (!openingMessagePromise) {
        // A slow model must not leave "…" on screen for ever: after a few seconds the store's own greeting is shown.
        const waitForAi = new AbortController();
        const giveUp = setTimeout(() => waitForAi.abort(), GREETING_WAIT_MS);
        openingMessagePromise = fetch("/apps/ai-agent/greeting", {
          method: "POST",
          signal: waitForAi.signal,
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            localHour: new Date().getHours(),
            languageChoice: preferredLanguage || undefined,
            // so the server can recognise this opening line when the chat history comes back
            clientId: clientId || undefined,
          }),
        })
          .then((response) => (response.ok ? response.json() : {}))
          .then((data) => (typeof data?.greeting === "string" && data.greeting.trim()) || fallbackGreeting())
          .catch(() => fallbackGreeting())
          .finally(() => clearTimeout(giveUp));
      }
      return openingMessagePromise;
    }

    function chatIsEmpty() {
      return (
        !messages.querySelector(".ai-commerce-chat-user") &&
        !messages.querySelector(".ai-commerce-chat-bot") &&
        !chatHistory.length
      );
    }

    let openingMessageShown = null;
    let openingSpokenText = "";
    // Shows the AI's opening message ONCE per chat. A greeting that is already on screen (also one
    // restored after a page reload) is reused; a second one is never fetched.
    function showOpeningMessage() {
      if (openingMessageShown) return openingMessageShown;
      const existing = [...messages.querySelectorAll(".ai-commerce-chat-bot")].pop();
      if (existing && !messages.querySelector(".ai-commerce-chat-user")) {
        openingMessageShown = Promise.resolve((existing.dataset.rawText || existing.textContent || "").trim());
        return openingMessageShown;
      }
      const bubble = addMessage("…", "bot");
      openingMessageShown = fetchOpeningMessage().then((text) => {
        if (!text) {
          bubble.remove();
          return "";
        }
        bubble.dataset.rawText = text;
        renderFormattedBotText(bubble, text, { stream: true });
        void loadSuggestions("", text);
        if (!chatHistory.some((item) => item.role === "assistant" && item.content === text)) {
          chatHistory.push({ role: "assistant", content: text });
        }
        try {
          saveChatState();
        } catch {}
        // A voice session that started before the greeting arrived must know it was said.
        if (voiceSocket && voiceSocket.readyState === WebSocket.OPEN) {
          try {
            voiceSocket.send(JSON.stringify({ type: "sync_history", history: chatHistory.slice(-12), clientId }));
          } catch {}
        }
        return text;
      });
      return openingMessageShown;
    }

    function addMessage(text, type, options = {}) {
      const message = document.createElement("div");
      message.className = `ai-commerce-chat-message ai-commerce-chat-${type}`;
      message.dataset.rawText = String(text || "").trim();
      message.dataset.time = formatMsgTime();
      messages.appendChild(message);
      if (type === "bot") {
        renderFormattedBotText(message, text, options);
      } else {
        streamUserText(message, text, options);
      }
      // New message: scroll only if user is already near the bottom (prevents jump while reading cards)
      safeScrollMessagesToBottom(Boolean(options.forceScroll));
      if (!restoringState) saveChatState();
      return message;
    }

    // ---- Speech text: never voice bullets / + - x symbols; read email & phone clearly ----
    const SPEECH_CALLING_CODES = ["971", "966", "880", "977", "91", "92", "94", "44", "61", "64", "65", "60", "49", "33", "39", "34", "31", "27", "62", "63", "81", "86", "55", "52", "1", "7"];

    function speechPairDigits(value) {
      const d = String(value || "").replace(/\D/g, "");
      const out = [];
      let i = 0;
      if (d.length % 2 === 1 && d.length > 3) { out.push(d.slice(0, 3)); i = 3; }
      for (; i < d.length; i += 2) out.push(d.slice(i, i + 2));
      return out.join(" ");
    }

    function speechEmail(email, lang) {
      const at = lang === "en" ? " at " : " at the rate ";
      const [local, domain] = email.split("@");
      const say = (part) => part.replace(/\./g, " dot ").replace(/_/g, " underscore ").replace(/-/g, " dash ").replace(/\+/g, " plus ");
      return `${say(local)}${at}${say(domain)}`.replace(/\s+/g, " ").trim();
    }

    function speechPhone(raw, lang) {
      const digits = raw.replace(/\D/g, "");
      const code = SPEECH_CALLING_CODES.find((c) => digits.startsWith(c) && digits.length - c.length >= 6);
      const plus = lang === "hi" ? "प्लस" : "plus";
      return code ? `${plus} ${code}, ${speechPairDigits(digits.slice(code.length))}` : `${plus} ${speechPairDigits(digits)}`;
    }

    function formatForSpeech(text) {
      const raw = String(text || "");
      const lang = /[\u0900-\u097F]/.test(raw) ? "hi" : (preferredLanguage || "en");
      const is = lang === "en" ? "is" : "hai";
      return raw
        .replace(/https?:\/\/\S+/gi, "")
        .replace(/\bE-?mail(?:\s+address)?\s*:\s*/gi, `Email ${is} `)
        .replace(/\bPhone(?:\s+number)?\s*:\s*/gi, `Phone number ${is} `)
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, (m) => speechEmail(m, lang))
        .replace(/(?:\+|\b00)\s?\d[\d\s().-]{6,17}\d/g, (m) => speechPhone(m, lang))
        .replace(/(?<![\d.,])\d{10}(?![\d])/g, (m) => speechPairDigits(m))
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/[:\(\[\*]\s*(?:smile|smiling face|winky smile|wink|stars?|sparkles?|double heart|two hearts|sparkling heart|memo|lock and key|shopping bags?|heart|thumbs up|check mark|fire|party)\s*[:\)\]\*]/gi, " ")
        .replace(/\b(?:winky smile|double heart|sparkling heart|lock and key|smiling face with hearts?)\b/gi, "")
        .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, "")
        .replace(/^\s*#{1,6}\s+/gm, "")
        // list markers (1. 2) • - *) are never spoken, in any language
        .replace(/^\s*(?:\d{1,2}[.)]|[•\-*–—])\s+/gm, "")
        .replace(/\s*•\s*/g, ". ")
        // quantity "× 1" is dropped; "× 2" becomes "quantity 2"; operators are never voiced
        .replace(/\s[×✕✖]\s*1\b/g, "")
        .replace(/\s[×✕✖xX]\s*(\d+)\b/g, ", quantity $1")
        .replace(/[×✕✖÷=]/g, " ")
        .replace(/(?<=\s)[+\-–—](?=\s)/g, " ")
        .replace(/\+(?=\D)/g, " ")
        .replace(/\+(?=\d)/g, "")
        .replace(/\s*\/\s*/g, ", ")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\|/g, ". ")
        .replace(/[—–]/g, ", ")
        .replace(/\p{Extended_Pictographic}/gu, "")
        .replace(/[\u{1F000}-\u{1FAFF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B50}\u{20E3}\u{FE0E}\u{FE0F}\u{200D}]/gu, "")
        .replace(/([:;,])[ \t]*\r?\n+/g, "$1 ")
        .replace(/\r?\n+/g, ". ")
        .replace(/([.!?।])\s*\./g, "$1")
        .replace(/,\s*,/g, ",")
        .replace(/\s+/g, " ")
        .trim();
    }

    let speechSessionId = 0;
    let activeUtterance = null;

    function splitForSpeech(text) {
      let sentences;
      try {
        sentences = text.split(/(?<=[.!?।])\s+/);
      } catch {
        sentences = [text];
      }

      const chunks = [];
      let current = "";

      for (const sentence of sentences) {
        if (current && current.length + sentence.length > 160) {
          chunks.push(current);
          current = sentence;
        } else {
          current = current ? `${current} ${sentence}` : sentence;
        }
      }

      if (current) chunks.push(current);
      return chunks;
    }

    const FEMALE_VOICE_HINTS = [
      "swara",
      "neerja",
      "aria",
      "jenny",
      "sonia",
      "natasha",
      "libby",
      "lekha",
      "veena",
      "google \u0939\u093f\u0928\u094d\u0926\u0940",
      "google uk english female",
      "google us english",
      "samantha",
      "karen",
      "tessa",
      "moira",
      "zira",
      "heera",
      "kalpana",
      "female",
      "woman",
    ];
    const MALE_VOICE_HINTS = [
      "madhur",
      "prabhat",
      "ravi",
      "hemant",
      "rishi",
      "david",
      "mark",
      "daniel",
      "alex",
      "fred",
      "george",
      "guy",
      "ryan",
      "james",
      "male",
      "man",
    ];
    // Phone speech engines (especially the offline ones) sound robotic when sped up or pitched,
    // so phones use neutral rate/pitch; desktop keeps the slightly livelier settings.
    const IS_MOBILE_DEVICE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
    const VOICE_PITCH = IS_MOBILE_DEVICE ? 1.0 : 1.05;
    const VOICE_RATE = IS_MOBILE_DEVICE ? 1.0 : 1.1;
    let cachedVoices = [];

    function loadVoices() {
      if (!("speechSynthesis" in window)) return;
      cachedVoices = window.speechSynthesis.getVoices() || [];
    }

    if ("speechSynthesis" in window) {
      loadVoices();
      window.speechSynthesis.addEventListener?.("voiceschanged", loadVoices);
    }

    function rankVoices(wantHindi, skipPreferred = false) {
      if (cachedVoices.length === 0) loadVoices();

      if (!skipPreferred) {
        // Replies are often Hinglish (Hindi in Roman letters), which an English voice reads badly. So,
        // unless the shopper chose English in the language menu, the device's best Hindi (hi-IN) voice
        // reads every reply, the same on laptop and phone.
        const hindi = rankVoices(true, true);
        if (hindi && (hindi.lang || "").toLowerCase().replace("_", "-").startsWith("hi")) return hindi;
      }

      const targetLang = wantHindi ? "hi" : "en";
      const looksMale = (voice) =>
        MALE_VOICE_HINTS.some((hint) => new RegExp(`\\b${hint}\\b`, "i").test(voice.name));

      const score = (voice) => {
        const name = voice.name.toLowerCase();
        const lang = (voice.lang || "").toLowerCase().replace("_", "-");
        let points = 0;

        if (looksMale(voice)) return -100;

        const hintIndex = FEMALE_VOICE_HINTS.findIndex((hint) => name.includes(hint));
        if (hintIndex !== -1) points += 50 - hintIndex;

        if (lang.startsWith(targetLang)) points += 30;
        if (!wantHindi && lang === "en-in") points += 15;
        if (wantHindi && lang === "hi-in") points += 15;
        if (/natural|neural/.test(name)) points += 20;
        // Voices that run on the device start speaking at once. Online voices ("Google ...", "...
        // Online") first fetch audio from the internet, which adds 1-3 seconds before EVERY sentence,
        // so a device voice always wins when the device has one for the language.
        if (voice.localService !== false && !/network|online/.test(`${name} ${voice.voiceURI || ""}`.toLowerCase())) points += 60;

        return points;
      };

      const ranked = [...cachedVoices]
        .filter((voice) => (voice.lang || "").toLowerCase().startsWith(targetLang) || !wantHindi)
        .map((voice) => ({ voice, points: score(voice) }))
        .sort((a, b) => b.points - a.points);

      if (ranked.length > 0 && ranked[0].points > 0) return ranked[0].voice;

      // No recognisably female voice: still settle on ONE voice for the language, deterministically,
      // instead of leaving it to the OS default (which can differ from reply to reply).
      const sameLang = [...cachedVoices]
        .filter((voice) => (voice.lang || "").toLowerCase().replace("_", "-").startsWith(targetLang) && !looksMale(voice))
        .sort((a, b) => String(a.voiceURI).localeCompare(String(b.voiceURI)));
      return sameLang[0] || null;
    }

    const pickedVoiceByGroup = {};

    function readSavedVoiceURI(group) {
      try {
        return localStorage.getItem(`aiCommerceTtsVoice:v3:${group}`) || "";
      } catch {
        return "";
      }
    }

    function saveVoiceURI(group, uri) {
      try {
        localStorage.setItem(`aiCommerceTtsVoice:v3:${group}`, uri);
      } catch {}
    }

    // One voice per language, chosen once and then kept: the same voice for every reply in the
    // conversation and on later visits on this device, even when the browser's voice list loads late
    // or comes back in a different order (common on phones).
    function pickFemaleVoice(wantHindi) {
      // English chosen in the menu: English replies get an English voice (no Hindi accent).
      const englishOnly = !wantHindi && preferredLanguage === "en";
      const group = wantHindi ? "hi" : englishOnly ? "en-only" : "en";
      if (cachedVoices.length === 0) loadVoices();
      if (cachedVoices.length === 0) return null;

      const current = pickedVoiceByGroup[group];
      const fresh = current ? cachedVoices.find((voice) => voice.voiceURI === current.voiceURI) : null;
      if (fresh) return fresh;

      const savedURI = readSavedVoiceURI(group);
      const saved = savedURI ? cachedVoices.find((voice) => voice.voiceURI === savedURI) : null;
      const chosen = saved || rankVoices(wantHindi, englishOnly);
      if (chosen) {
        pickedVoiceByGroup[group] = chosen;
        saveVoiceURI(group, chosen.voiceURI);
        try { console.info("[ai-commerce-widget] speaking voice:", chosen.name, chosen.lang, group); } catch {}
      }
      return chosen;
    }

    // Phones load their voice list late. Wait (briefly) for it so the first reply is not spoken in the
    // OS default voice and the following ones in a different one.
    function whenVoicesReady(callback) {
      if (!("speechSynthesis" in window)) {
        callback();
        return;
      }
      loadVoices();
      if (cachedVoices.length > 0) {
        callback();
        return;
      }
      let done = false;
      let timer = null;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.speechSynthesis.removeEventListener?.("voiceschanged", onChange);
        loadVoices();
        callback();
      };
      const onChange = () => {
        loadVoices();
        if (cachedVoices.length > 0) finish();
      };
      window.speechSynthesis.addEventListener?.("voiceschanged", onChange);
      timer = setTimeout(finish, 1500);
    }

    // Server voice = the same natural voice on every device. Turned off in the theme editor, or
    // automatically for this visit when the server says it is unavailable (503).
    // Replies are spoken by the browser's own voice: it starts at once (no server round trip).
    // Chrome keeps a paused queue alive through cancel(), so resume first, then cancel.
    function cancelBrowserSpeech() {
      if (!("speechSynthesis" in window)) return;
      try {
        if (window.speechSynthesis.paused) window.speechSynthesis.resume();
        window.speechSynthesis.cancel();
      } catch {}
    }

    // While a possible interruption is checked, the browser's voice is paused at once (so it neither talks over the
    // shopper nor feeds its own sound back into the microphone). No real words: it carries on from where it stopped.
    function pauseBrowserSpeech() {
      if (!("speechSynthesis" in window)) return;
      try {
        window.speechSynthesis.pause();
      } catch {}
    }
    function resumeBrowserSpeech() {
      if (!("speechSynthesis" in window)) return;
      try {
        if (window.speechSynthesis.paused) window.speechSynthesis.resume();
      } catch {}
    }

    let playbackAudioContext = null;
    let serverAudioSource = null;

    function getPlaybackAudioContext() {
      if (!playbackAudioContext || playbackAudioContext.state === "closed") {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        playbackAudioContext = new AudioContextClass();
      }
      if (playbackAudioContext.state === "suspended") {
        playbackAudioContext.resume().catch(() => {});
      }
      return playbackAudioContext;
    }

    function stopServerPcmAudio() {
      if (serverAudioSource) {
        try {
          serverAudioSource.onended = null;
          serverAudioSource.stop();
        } catch {}
        serverAudioSource = null;
      }
    }

    function playServerPcmAudio(base64Pcm, sampleRate = 24000) {
      if (suppressVoiceAnswers) return;

      stopAssistantAudio();
      stopServerPcmAudio();
      cancelBrowserSpeech();

      const sessionId = ++speechSessionId;

      try {
        const binary = atob(base64Pcm);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const int16 = new Int16Array(bytes.buffer);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
          float32[i] = int16[i] / (int16[i] < 0 ? 32768 : 32767);
        }

        const ctx = getPlaybackAudioContext();
        const buffer = ctx.createBuffer(1, float32.length, sampleRate);
        buffer.getChannelData(0).set(float32);

        const srcNode = ctx.createBufferSource();
        srcNode.buffer = buffer;
        srcNode.connect(ctx.destination);
        serverAudioSource = srcNode;

        markSpeaking();

        srcNode.onended = () => {
          if (serverAudioSource === srcNode) {
            serverAudioSource = null;
          }
          finishSpeaking(sessionId);
        };

        srcNode.start();
      } catch (err) {
        console.warn("[voice] server audio playback failed:", err);
        finishSpeaking(sessionId);
        if (lastAnswerText) {
          speakResponse(lastAnswerText);
        }
      }
    }

    function stopAssistantAudio() {
      stopServerPcmAudio();
    }

    function setMicTrackEnabled(enabled) {
      if (mediaStream) {
        try {
          mediaStream.getAudioTracks().forEach((track) => {
            // a muted mic stays off even when thinking mode ends
            track.enabled = Boolean(enabled) && !isMicMuted;
          });
        } catch (e) {
          console.warn("[voice] mic track toggle failed:", e);
        }
      }
    }

    function enterThinkingMode(runId) {
      isThinking = true;
      setMicTrackEnabled(false);
      voiceBuffer = [];
      voiceBufferLength = 0;
      recentSpeech.length = 0;
      bargeInHits = 0;
      interruptAssistant();
      suppressVoiceAnswers = false;
      if (typeof runId === "number") {
        latestTranscriptRunId = runId;
        if (runId > interruptedRunId) interruptedRunId = 0; // a newer turn than the one cut off: nothing stale is left to drop
      }
      if (status) status.textContent = ui("lblThink");
      syncVoiceStrip();
    }

    function exitThinkingMode() {
      if (!isThinking) return;
      isThinking = false;
      setMicTrackEnabled(true);
      syncVoiceStrip();
    }

    function markSpeaking() {
      exitThinkingMode();
      if (!isSpeakingResponse) speechStartedAt = Date.now();
      isSpeakingResponse = true;

      if (status) {
        status.textContent = isVoiceListening
          ? "Assistant is speaking… talk to interrupt"
          : "Assistant is speaking…";
      }
      syncVoiceStrip();
    }

    function finishSpeaking(sessionId) {
      if (sessionId !== speechSessionId) return;

      activeUtterance = null;
      isSpeakingResponse = false;
      speechEndedAt = Date.now();
      bargeCandidateUntil = 0;
      exitThinkingMode();
      try {
        localStorage.removeItem(uiStateKey("pendingSpeech"));
      } catch {}
      window.__aiCommerceLastSpeech = "";
      micMutedUntil = Date.now() + POST_SPEECH_MUTE_MS;

      if (status) {
        status.textContent = isVoiceListening ? "Listening…" : "";
      }
      syncVoiceStrip();
    }

    function speakWithBrowser(chunks, sessionId, wantHindi, startIndex = 0) {
      if (!("speechSynthesis" in window)) {
        finishSpeaking(sessionId);
        return;
      }

      const lang = wantHindi ? "hi-IN" : "en-US";
      let femaleVoice = null;
      let index = startIndex;

      const speakNext = () => {
        if (sessionId !== speechSessionId) return;

        if (index >= chunks.length) {
          finishSpeaking(sessionId);
          return;
        }

        const utterance = new SpeechSynthesisUtterance(chunks[index++]);

        if (femaleVoice) {
          try {
            utterance.voice = femaleVoice;
          } catch {}
          utterance.lang = femaleVoice.lang || lang;
        } else {
          utterance.lang = lang;
        }

        utterance.rate = VOICE_RATE;
        utterance.pitch = VOICE_PITCH;

        utterance.onstart = () => {
          if (sessionId !== speechSessionId) return;
          markSpeaking();
        };

        utterance.onend = speakNext;
        utterance.onerror = (event) => {
          console.warn("[voice] speech error:", event?.error);
          speakNext();
        };

        activeUtterance = utterance;
        window.speechSynthesis.speak(utterance);
      };

      whenVoicesReady(() => {
        if (sessionId !== speechSessionId) return;
        femaleVoice = pickFemaleVoice(wantHindi);
        speakNext();
      });
    }

    function speakResponse(text) {
      // Only voice mode speaks. Text chat replies are never read aloud.
      if (!text || !(isVoiceListening || isVoiceConnecting)) return;

      if (suppressVoiceAnswers) {
        console.log("speakResponse skipped (suppressed after interrupt)");
        return;
      }

      const chunks = splitForSpeech(formatForSpeech(text));
      if (chunks.length === 0) return;

      window.__aiCommerceLastSpeech = String(text).trim();
      try {
        localStorage.setItem(
          uiStateKey("pendingSpeech"),
          JSON.stringify({ text: window.__aiCommerceLastSpeech, at: Date.now() })
        );
      } catch {}

      stopAssistantAudio();
      cancelBrowserSpeech();
      bargeGate.cancel();

      const sessionId = ++speechSessionId;
      const wantHindi = /[\u0900-\u097F]/.test(text);

      markSpeaking();

      speakWithBrowser(chunks, sessionId, wantHindi);
    }

    function getVariantId(product) {
      const rawId =
        product?.variantId ||
        product?.variant_id ||
        product?.variants?.[0]?.id;
      if (!rawId) return null;
      return String(rawId).split("/").pop();
    }

    function formatMoney(amount, currency) {
      const value = Number(amount);
      if (!Number.isFinite(value)) return "";

      try {
        return new Intl.NumberFormat(currency === "INR" ? "en-IN" : undefined, {
          style: "currency",
          currency,
          // Whole amounts read cleaner without ".00" (₹1,799); fractional ones keep both decimals.
          ...(Number.isInteger(value) ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}),
        }).format(value);
      } catch {
        return `${currency || ""} ${value.toFixed(2)}`.trim();
      }
    }

    function discountPercent(price, compareAt) {
      const current = Number(price);
      const regular = Number(compareAt);

      if (!Number.isFinite(current) || !Number.isFinite(regular)) return 0;
      if (regular <= 0 || regular <= current) return 0;

      return Math.round((1 - current / regular) * 100);
    }

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    }

    function renderProductCards(products) {
      // a malformed list from the backend (a null, a number, an entry with no title) must not stop the good cards from showing
      if (Array.isArray(products)) {
        products = products.filter((p) => p && typeof p === "object" && !Array.isArray(p) && (p.title || p.name));
      }
      displayedProducts = products;
      if (!Array.isArray(products) || products.length === 0) return;

      const isComparison = products.some(
        (p) =>
          p?.cardMode === "comparison" ||
          p?.comparisonMode === true ||
          (Array.isArray(p?.comparisonPoints) && p.comparisonPoints.length > 0)
      );
      const isSingle = products.length === 1 && !isComparison;

      const grid = el("div", "ai-commerce-product-grid");
      if (isComparison) grid.classList.add("ai-commerce-product-grid--compare");
      if (isSingle) grid.classList.add("ai-commerce-product-grid--single");
      grid._products = products;
      grid.dataset.mode = isComparison ? "comparison" : isSingle ? "single" : "collection";

      // Horizontal Scroll Container
      const track = el("div", "ai-commerce-carousel-track");
      if (isSingle) track.classList.add("ai-commerce-carousel-track--single");
      if (isComparison) track.classList.add("ai-commerce-carousel-track--compare");

      products.forEach((product) => {
        const currency = product.currency || "";
        const allVariants =
          Array.isArray(product.variants) && product.variants.length > 0
            ? product.variants.map((v) => ({
                ...v,
                id: String(v.id || "").split("/").pop(),
                available: v.available !== undefined ? Boolean(v.available) : v.sellable !== false,
              }))
            : null;
        const variants =
          allVariants && allVariants.length > 1 ? allVariants : null;

        // The variant the assistant itself picked (the one it named and priced in its reply: the one the shopper
        // asked for, otherwise the cheapest) is preselected, so the card never shows a different price than the text.
        const pickedId = String(product.variantId || product.variant_id || "").split("/").pop();
        const firstAvailVariant = allVariants
          ? allVariants.find((v) => pickedId && String(v.id) === pickedId && v.available) ||
            allVariants.find((v) => v.available) ||
            allVariants[0]
          : null;

        let pendingChipInit = null;
        const state = {
          variantId: firstAvailVariant ? String(firstAvailVariant.id) : getVariantId(product),
          price: firstAvailVariant?.price ?? product.price,
          compareAtPrice: firstAvailVariant?.compareAtPrice ?? product.compareAtPrice,
          quantity:
            firstAvailVariant?.quantity !== undefined
              ? firstAvailVariant.quantity
              : product.inventoryQuantity,
          soldOut: firstAvailVariant
            ? !firstAvailVariant.available
            : product.inventoryQuantity === 0 && product.inventoryPolicy !== "CONTINUE",
        };

        const productUrl = product.handle
          ? `/products/${encodeURIComponent(product.handle)}`
          : safeUrl(product.onlineStoreUrl || product.url) || "#";

        const card = el("article", "ai-commerce-product-card");
        if (isComparison) card.classList.add("ai-commerce-product-card--compare");
        if (isSingle) card.classList.add("ai-commerce-product-card--single");

        // Floating Discount & Stock Badges
        const badgesRow = el("div", "ai-commerce-product-badges");
        const badge = el("span", "ai-commerce-product-badge");
        const stock = el("span", "ai-commerce-product-stock");
        badgesRow.append(badge);
        card.appendChild(badgesRow);

        const cardBody = el("div", "ai-commerce-product-card-body");

        const imageUrl = product.image || product.imageUrl || product.image_url;
        const media = el("a", "ai-commerce-product-media");
        media.href = productUrl;
        media.target = "_blank";
        media.rel = "noopener";
        media.setAttribute("aria-label", product.title || "Product");

        if (imageUrl) {
          const image = el("img", "ai-commerce-product-image");
          image.src = safeUrl(imageUrl);
          image.alt = product.imageAlt || product.title || "Product";
          image.loading = "lazy";
          image.addEventListener("error", () => image.remove()); // a broken image leaves the soft gradient, never alt text
          media.appendChild(image);
        }
        cardBody.appendChild(media);

        cardBody.appendChild(stock);
        const title = el("a", "ai-commerce-product-title", product.title || ui("untitled"));
        title.href = productUrl;
        title.target = "_blank";
        title.rel = "noopener";
        cardBody.appendChild(title);

        const prices = el("div", "ai-commerce-product-prices");
        const priceEl = el("span", "ai-commerce-product-price");
        const compareEl = el("span", "ai-commerce-product-compare-price");
        prices.append(priceEl, compareEl);
        cardBody.appendChild(prices);

        if (product.fitReason || product.stylistNote) {
          cardBody.appendChild(
            el("p", "ai-commerce-product-note", product.fitReason || product.stylistNote)
          );
        }

        // Comparison mode: checklist instead of variant dropdown
        if (isComparison) {
          const points =
            Array.isArray(product.comparisonPoints) && product.comparisonPoints.length > 0
              ? product.comparisonPoints
              : (Array.isArray(product.features) ? product.features : []).map((f) => ({
                  label: String(f || "").trim(),
                  present: true,
                }));

          if (points.length > 0) {
            const detailsBox = el("div", "ai-commerce-product-details-box ai-commerce-product-compare-box");
            const featList = el("ul", "ai-commerce-product-features ai-commerce-product-compare-list");
            points.slice(0, 6).forEach((pt) => {
              const label = typeof pt === "string" ? pt : String(pt?.label || "").trim();
              if (!label) return;
              const present =
                typeof pt === "string"
                  ? true
                  : pt?.present !== false && pt?.has !== false && pt?.checked !== false;
              // Only show what this product actually has; never a "missing" mark for the other product's features.
              if (!present) return;
              const li = el("li", present ? "ai-commerce-check-yes" : "ai-commerce-check-no");
              const icon = el("span", "ai-commerce-check-icon");
              icon.setAttribute("aria-hidden", "true");
              icon.textContent = present ? "✓" : "✕";
              li.appendChild(icon);
              li.appendChild(document.createTextNode(label));
              featList.appendChild(li);
            });
            detailsBox.appendChild(featList);
            cardBody.appendChild(detailsBox);
          }
        } else {
          // Options (size, colour...) only when the product really has more than one.
          if (variants) {
            // Options as tappable chips (one per variant), like the approved design
            const chips = el("div", "ai-commerce-product-variant");
            chips.setAttribute("role", "radiogroup");
            chips.setAttribute("aria-label", `Options for ${product.title || "product"}`);
            const chipFor = new Map();
            const selectVariant = (variant) => {
              state.variantId = String(variant.id);
              state.price = variant.price ?? product.price;
              state.compareAtPrice = variant.compareAtPrice ?? product.compareAtPrice;
              state.quantity = variant.quantity;
              state.soldOut = !variant.available;
              chipFor.forEach((chip, id) => {
                const on = id === state.variantId;
                chip.classList.toggle("is-selected", on);
                chip.setAttribute("aria-checked", on ? "true" : "false");
              });
              paint();
            };
            variants.forEach((variant) => {
              const cleanTitle = variant.title && variant.title !== "Default Title" ? variant.title : "Standard";
              const chip = el("button", "ai-commerce-variant-chip", cleanTitle);
              chip.type = "button";
              chip.setAttribute("role", "radio");
              chip.title = variant.available ? cleanTitle : `${cleanTitle} (Out of stock)`;
              if (!variant.available) chip.classList.add("is-soldout");
              chip.addEventListener("click", () => selectVariant(variant));
              chipFor.set(String(variant.id), chip);
              chips.appendChild(chip);
            });
            cardBody.appendChild(chips);
            pendingChipInit = () => {
              const first = variants.find((v) => String(v.id) === String(state.variantId)) || variants.find((v) => v.available) || variants[0];
              if (first) selectVariant(first);
            };
          }
        }

        card.appendChild(cardBody);

        // Soft Gradient Add to Cart Button
        const addButton = el("button", "ai-commerce-product-add", "Add to cart");
        addButton.type = "button";
        card.appendChild(addButton);

        const paint = () => {
          priceEl.textContent = formatMoney(state.price, currency);

          const percent = discountPercent(state.price, state.compareAtPrice);
          badge.hidden = !percent;
          badge.textContent = percent ? `${percent}% OFF` : "";
          compareEl.hidden = !percent;
          compareEl.textContent = percent ? formatMoney(state.compareAtPrice, currency) : "";

          const low =
            !state.soldOut &&
            state.quantity != null &&
            state.quantity > 0 &&
            state.quantity <= 5;
          stock.hidden = !low;
          stock.textContent = low ? `Only ${state.quantity} left` : "";
          badgesRow.hidden = badge.hidden;

          addButton.disabled = Boolean(state.soldOut);
          addButton.textContent = state.soldOut ? "Out of stock" : "Add to cart";
        };

        paint();
        if (pendingChipInit) pendingChipInit();

        addButton.addEventListener("click", async () => {
          const chosenVariant = allVariants
            ? allVariants.find((v) => String(v.id) === String(state.variantId))
            : null;
          const displayTitle =
            chosenVariant &&
            chosenVariant.title &&
            chosenVariant.title !== "Default Title"
              ? `${product.title} (${chosenVariant.title})`
              : product.title;

          await addSelectedProductToCart(
            {
              ...product,
              title: displayTitle,
              variantId: state.variantId,
            },
            addButton
          );
        });

        track.appendChild(card);
      });

      grid.appendChild(track);
      messages.appendChild(grid);
      // Cards: only force scroll if user is already following the bottom of the chat
      safeScrollMessagesToBottom(false);
      if (!restoringState) saveChatState();
    }

    // fromAgent: the AI already told the customer in its reply, so only a real failure is shown.
    async function addSelectedProductToCart(product, button = null, { fromAgent = false } = {}) {
      if (!product) return;

      const variantId = getVariantId(product);

      if (!variantId) {
        addMessage(ui("pickVariant"), "bot");
        return;
      }

      const originalText = button?.textContent;

      if (button) {
        button.disabled = true;
        button.textContent = ui("adding");
      }

      try {
        const response = await fetch(cartUrl("cart/add.js"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          credentials: "same-origin",
          body: JSON.stringify({
            items: [
              {
                id: Number(variantId),
                quantity: Number(product.quantity) > 0 ? Number(product.quantity) : 1,
              },
            ],
          }),
        });

        const result = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(
            result.description ||
              result.message ||
              "Shopify could not add this product to the cart."
          );
        }

        showCartToast(`Added ${product.title} to cart`);
        if (!fromAgent) {
          // Added with the card's button (outside the conversation): let the AI know on the next turn.
          chatHistory.push({ role: "user", content: `[I added ${product.title} to my cart using the product card button.]` });
          chatHistory.splice(0, Math.max(0, chatHistory.length - HISTORY_KEEP));
          try {
            saveChatState();
          } catch {}
        }

        void refreshCartCount();

        void (async () => {
          const cart = await fetchCartSnapshot();
          if (cart && voiceSocket && voiceSocket.readyState === WebSocket.OPEN) {
            try {
              voiceSocket.send(
                JSON.stringify({
                  type: "cart_state",
                  cart,
                  clientId,
                  customerLoggedIn,
                  customer: storefrontCustomer,
                })
              );
            } catch {}
          }
        })();

        messages
          .querySelectorAll(".ai-commerce-checkout-link")
          .forEach((link) => link.remove());

        const checkout = document.createElement("a");
        checkout.href = "/checkout";
        checkout.className = "ai-commerce-checkout-link";
        checkout.textContent = ui("proceedCheckout");
        checkout.addEventListener("click", (e) => {
          e.preventDefault();
          input.value = "Proceed to checkout";
          form.requestSubmit();
        });
        messages.appendChild(checkout);

        messages.scrollTop = messages.scrollHeight;
      } catch (error) {
        console.error("Add to cart failed:", error);
        // Shopify's own reason (e.g. stock limit) is shown as is.
        const errorMessage = error.message || ui("cartAddFail");
        // The reply above said it was added (the assistant answers before the store's cart is touched): mark it, so the
        // shopper is not left with "Done" next to an error.
        if (fromAgent && lastAgentReplyEl && lastAgentReplyEl.isConnected && lastAgentReplyEl.nextElementSibling?.className !== "ai-commerce-reply-undone") {
          // a sibling, not a child: the reply is still being typed out and repaints its own content
          const note = document.createElement("div");
          note.className = "ai-commerce-reply-undone";
          note.textContent = "⚠ " + ui("cartAddFail");
          lastAgentReplyEl.insertAdjacentElement("afterend", note);
          lastAgentReplyEl.classList.add("is-undone");
        }
        addMessage(errorMessage, "bot");
        if (fromAgent) speakResponse(errorMessage);
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = originalText || "+ Add to cart";
        }
      }
    }

    // Dedicated post-order cart reset: empties the Shopify cart and resets post-order state
    // WITHOUT checking or emitting any "Your cart is empty" message!
    async function clearCartAfterOrderPlaced() {
      if (cartCount) cartCount.hidden = true;
      try {
        document.cookie = "discount_code=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
      } catch {}
      if (checkoutState && typeof checkoutState === "object") {
        checkoutState.appliedDiscount = null;
        checkoutState.discountAmount = 0;
        checkoutState.discountClearedAfterOrder = true;
        checkoutState.finalTotal = null;
        checkoutState.shippingMethod = "standard";
        checkoutState.shippingCost = 0;
        checkoutState.selectedPaymentMethod = null;
        checkoutState.paymentMethod = null;
        checkoutState.orderQuote = null;
        checkoutState.step = "cart";
        if (!customerLoggedIn) {
          checkoutState.shipping = null;
          checkoutState.billing = null;
          checkoutState.billingSameAsShipping = null;
          checkoutState.shippingConfirmed = false;
          checkoutState.billingConfirmed = false;
          checkoutState.customer = null;
          checkoutState.guestDetailsClearedAfterOrder = true;
        }
      }
      try {
        await fetch(cartUrl("cart/clear.js"), {
          method: "POST",
          headers: { Accept: "application/json" },
          credentials: "same-origin",
        }).catch(() => null);
        await refreshCartCount();
        const emptyCart = { item_count: 0, total_price: 0, items: [] };
        if (voiceSocket && voiceSocket.readyState === WebSocket.OPEN) {
          try {
            voiceSocket.send(
              JSON.stringify({
                type: "cart_state",
                cart: emptyCart,
                clientId,
                customerLoggedIn,
                customer: storefrontCustomer,
              })
            );
          } catch {}
        }
        try {
          document.dispatchEvent(new CustomEvent("cart:updated", { detail: { cart: emptyCart } }));
          document.dispatchEvent(new CustomEvent("cart:refresh"));
        } catch {}
      } catch {}
    }

    async function runCartActions(actions) {
      const result = { clearCart: "not_requested", cart: null };
      if (!Array.isArray(actions)) return result;

      const hasOrderPlaced = actions.some((a) => a?.type === "order_placed");

      for (const action of actions) {
        if (action?.type === "order_placed") {
          await clearCartAfterOrderPlaced();
          continue;
        }
        if (action?.type === "apply_discount" && action.discountCode) {
          continue;
        }
        if (action?.type === "clear_cart") {
          // If this clear_cart was triggered by order placement, skip it so it never checks the cart or emits "cart is empty"
          if (hasOrderPlaced || action.afterOrder || action.silent) {
            continue;
          }
          try {
            const postJson = async (url, body) => {
              const res = await fetch(url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/json",
                },
                credentials: "same-origin",
                body: body != null ? JSON.stringify(body) : undefined,
              });
              return res;
            };

            await fetch(cartUrl("cart/clear.js"), {
              method: "POST",
              headers: { Accept: "application/json" },
              credentials: "same-origin",
            }).catch(() => null);

            let cart = await fetchCartSnapshot();
            if (cart?.items?.length) {
              for (const item of cart.items) {
                if (item.key) {
                  await postJson(cartUrl("cart/change.js"), { id: item.key, quantity: 0 });
                } else if (item.variant_id != null) {
                  await postJson(cartUrl("cart/update.js"), {
                    updates: { [String(item.variant_id)]: 0 },
                  });
                }
              }
            }

            cart = await fetchCartSnapshot();
            await refreshCartCount();
            if (cart && voiceSocket && voiceSocket.readyState === WebSocket.OPEN) {
              try {
                voiceSocket.send(
                  JSON.stringify({
                    type: "cart_state",
                    cart,
                    clientId,
                    customerLoggedIn,
                    customer: storefrontCustomer,
                  })
                );
              } catch {}
            }
            try {
              document.dispatchEvent(new CustomEvent("cart:updated", { detail: { cart } }));
              document.dispatchEvent(new CustomEvent("cart:refresh"));
              if (window.Shopify && window.Shopify.onCartUpdate && cart) {
                try {
                  window.Shopify.onCartUpdate(cart);
                } catch {}
              }
            } catch {}

            result.cart = cart;
            result.clearCart = "cleared";
          } catch (err) {
            console.error("clear_cart failed:", err);
            result.clearCart = "failed";
          }
          continue;
        }
        if (action?.type === "add_to_cart") {
          await addSelectedProductToCart(
            {
              variantId: action.variantId,
              title: action.title || ui("theProduct"),
              quantity: action.quantity,
            },
            null,
            { fromAgent: true }
          );
          continue;
        }

        if (action?.type === "update_cart") {
          await updateCartLine(action);
          continue;
        }

        if (action?.type === "show_cart" && action.cart) {
          renderCartPreview(action.cart);
        }

        if (action?.type === "preview" && action.preview) {
          renderGenericPreview(action.preview);
        }
      }
      return result;
    }

    async function updateCartLine(action) {
      const quantity = Number(action.quantity);
      if (!Number.isFinite(quantity) || quantity < 0) return;

      try {
        let response;

        if (action.key) {
          response = await fetch(cartUrl("cart/change.js"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            credentials: "same-origin",
            body: JSON.stringify({
              id: action.key,
              quantity,
            }),
          });
        } else if (action.variantId) {
          response = await fetch(cartUrl("cart/update.js"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            credentials: "same-origin",
            body: JSON.stringify({
              updates: {
                [String(action.variantId)]: quantity,
              },
            }),
          });
        } else {
          addMessage(ui("cartLineFail"), "bot");
          return;
        }

        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(result.description || result.message || "Cart update failed");
        }

        // The AI's reply already said what changed; only the cart preview is refreshed.
        void refreshCartCount();

        const cart = await fetchCartSnapshot();
        if (cart) {
          renderCartPreview(await priceInStoreCurrency(cart));
          if (voiceSocket && voiceSocket.readyState === WebSocket.OPEN) {
            try {
              voiceSocket.send(
                JSON.stringify({
                  type: "cart_state",
                  cart,
                  clientId,
                  customerLoggedIn,
                  customer: storefrontCustomer,
                })
              );
            } catch {}
          }
        }
      } catch (error) {
        console.error("update cart failed:", error);
        addMessage(error.message || ui("cartUpdateFail"), "bot");
      }
    }

    // One renderer for EVERY preview the agent decides to show (placed order, order review, anything else).
    // The server sends plain data: { title, badge, items[], sections[{heading, rows[{label,value}]}], totals[] }.
    function renderGenericPreview(preview) {
      if (!preview || typeof preview !== "object") return;
      const items = Array.isArray(preview.items) ? preview.items : [];
      const sections = Array.isArray(preview.sections) ? preview.sections : [];
      const totals = Array.isArray(preview.totals) ? preview.totals : [];
      if (!items.length && !sections.length && !totals.length) return;

      const card = el("div", "ai-commerce-preview-card");
      card._preview = preview;

      const head = el("div", "ai-commerce-preview-head");
      head.appendChild(el("p", "ai-commerce-preview-title", String(preview.title || "Preview")));
      if (preview.badge) head.appendChild(el("span", "ai-commerce-preview-badge", String(preview.badge)));
      card.appendChild(head);

      if (items.length) {
        const list = el("div", "ai-commerce-preview-items");
        items.forEach((item) => {
          const row = el("div", "ai-commerce-preview-item");
          const name = item.variant ? `${item.title} — ${item.variant}` : item.title || "Item";
          row.appendChild(el("span", "ai-commerce-preview-item-name", `${name} × ${item.quantity || 1}`));
          if (item.price) row.appendChild(el("span", "ai-commerce-preview-item-price", String(item.price)));
          list.appendChild(row);
        });
        card.appendChild(list);
      }

      sections.forEach((section) => {
        const rows = Array.isArray(section.rows) ? section.rows : [];
        if (!rows.length) return;
        const box = el("div", "ai-commerce-preview-section");
        if (section.heading) box.appendChild(el("p", "ai-commerce-preview-heading", String(section.heading)));
        rows.forEach((r) => {
          const line = el("div", "ai-commerce-preview-row");
          line.appendChild(el("span", "ai-commerce-preview-label", String(r.label || "")));
          const value = String(r.value ?? "");
          if (/^https?:\/\//i.test(value)) {
            const a = el("a", "ai-commerce-preview-value", "Open tracking");
            a.href = value;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            line.appendChild(a);
          } else {
            line.appendChild(el("span", "ai-commerce-preview-value", value));
          }
          box.appendChild(line);
        });
        card.appendChild(box);
      });

      if (totals.length) {
        const box = el("div", "ai-commerce-preview-totals");
        totals.forEach((t) => {
          const line = el("div", "ai-commerce-preview-row" + (t.strong ? " strong" : ""));
          line.appendChild(el("span", "ai-commerce-preview-label", String(t.label || "")));
          line.appendChild(el("span", "ai-commerce-preview-value", String(t.value ?? "")));
          box.appendChild(line);
        });
        card.appendChild(box);
      }

      messages.appendChild(card);
      messages.scrollTop = messages.scrollHeight;
      if (!restoringState) saveChatState();
    }

    // The storefront cart can be in the visitor's market currency; the store sells in its own. The backend prices the same
    // items again from the store's prices, so the cart panel shows the same currency as the cards, the reply and the order.
    async function priceInStoreCurrency(cart) {
      try {
        const res = await fetch("/apps/ai-agent/cart-view", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cart }) });
        if (!res.ok) return cart;
        const data = await res.json();
        return data && data.cart && Array.isArray(data.cart.items) ? { ...cart, ...data.cart } : cart;
      } catch {
        return cart;
      }
    }

    function renderCartPreview(cart) {
      if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) {
        return;
      }

      const panelEl = el("div", "ai-commerce-cart-preview");
      panelEl._cart = cart;
      panelEl.appendChild(el("p", "ai-commerce-cart-preview-title", "Your cart"));

      cart.items.forEach((item) => {
        const row = el("div", "ai-commerce-cart-preview-row");

        if (item.image) {
          const img = el("img", "ai-commerce-cart-preview-img");
          img.src = safeUrl(item.image);
          img.alt = item.title || "";
          img.loading = "lazy";
          row.appendChild(img);
        } else {
          row.appendChild(el("div", "ai-commerce-cart-preview-img placeholder"));
        }

        const info = el("div", "ai-commerce-cart-preview-info");
        const name =
          item.variant_title && item.variant_title !== "Default Title"
            ? `${item.title} — ${item.variant_title}`
            : item.title || "Item";
        info.appendChild(el("p", "ai-commerce-cart-preview-name", name));
        info.appendChild(
          el(
            "p",
            "ai-commerce-cart-preview-meta",
            `Qty ${item.quantity || 1}${
              item.line_price != null ? " · " + formatMoney(Number(item.line_price) / 100, cart.currency) : ""
            }`
          )
        );
        row.appendChild(info);
        panelEl.appendChild(row);
      });

      if (cart.total_price != null) {
        panelEl.appendChild(
          el(
            "p",
            "ai-commerce-cart-preview-total",
            `Total ${formatMoney(Number(cart.total_price) / 100, cart.currency)}`
          )
        );
      }

      messages.appendChild(panelEl);
      messages.scrollTop = messages.scrollHeight;
      if (!restoringState) saveChatState();
    }

    function interruptAssistant() {
      speechSessionId++;
      activeUtterance = null;
      bargeGate.cancel();
      stopAssistantAudio();
      cancelBrowserSpeech();

      isSpeakingResponse = false;
      speechEndedAt = Date.now();
      bargeCandidateUntil = 0;
      bargeInHits = 0;
      speakingChunks = 0;
      echoLevel = 0;

      if (status && isVoiceListening && !isThinking) status.textContent = ui("lblListen");
      syncVoiceStrip();
    }

    function bargeInInterrupt() {
      const wasSpeaking = isSpeakingResponse;
      if (wasSpeaking) interruptedRunId = Math.max(interruptedRunId, lastAnswerRunId);
      voiceAnswerEpoch++;
      suppressVoiceAnswers = true;
      interruptAssistant();

      if (!wasSpeaking) return;

      try {
        if (voiceSocket && voiceSocket.readyState === WebSocket.OPEN) {
          voiceSocket.send(JSON.stringify({ type: "interrupt" }));
        }
      } catch {}
    }

    function computeRms(samples) {
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        sum += samples[i] * samples[i];
      }
      return Math.sqrt(sum / samples.length);
    }

    function queueVoiceChunk(socket, base64) {
      if (!base64 || isThinking) return;

      if (voiceSessionReady) {
        socket.send(JSON.stringify({ type: "audio", data: base64 }));
        return;
      }

      if (voiceBufferLength + base64.length <= MAX_BUFFER_SECONDS * 16000 * 2) {
        voiceBuffer.push(base64);
        voiceBufferLength += base64.length;
      }
    }

    function pcmToBase64(floatSamples, inputRate) {
      const ratio = inputRate / TARGET_SAMPLE_RATE;
      const outputLength = Math.floor(floatSamples.length / ratio);
      const pcm = new Int16Array(outputLength);

      for (let i = 0; i < outputLength; i++) {
        const sourceIndex = Math.min(Math.floor(i * ratio), floatSamples.length - 1);
        const sample = Math.max(-1, Math.min(1, floatSamples[sourceIndex]));
        pcm[i] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
      }

      const bytes = new Uint8Array(pcm.buffer);
      let binary = "";
      const chunkSize = 0x8000;

      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
      }

      return btoa(binary);
    }

    function stopAudioCapture() {
      try {
        processorNode?.disconnect();
        sourceNode?.disconnect();
        silentGain?.disconnect();
      } catch {}

      processorNode = null;
      sourceNode = null;
      silentGain = null;

      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
        mediaStream = null;
      }

      if (audioContext) {
        const context = audioContext;
        audioContext = null;
        context.close().catch(() => {});
      }
    }

    function stopVoice({ closeSocket = true, userInitiated = false } = {}) {
      dropLiveTranscript();
      isMicMuted = false;
      exitThinkingMode();
      isVoiceListening = false;
      isVoiceConnecting = false;
      voiceSessionReady = false;
      voiceBuffer = [];
      voiceBufferLength = 0;
      recentSpeech.length = 0;
      bargeInHits = 0;

      stopAudioCapture();

      if (userInitiated) {
        try {
          localStorage.setItem(uiStateKey("voice"), "0");
        } catch {}
      }

      if (closeSocket && voiceSocket) {
        const socket = voiceSocket;
        voiceSocket = null;

        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING
        ) {
          socket.close(1000, "Voice stopped");
        }
      }

      setMicState("idle");
    }

    function sendBufferedAudio() {
      if (
        isThinking ||
        !voiceSessionReady ||
        !voiceSocket ||
        voiceSocket.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      while (voiceBuffer.length > 0) {
        const chunk = voiceBuffer.shift();
        voiceBufferLength -= chunk.length;

        voiceSocket.send(
          JSON.stringify({
            type: "audio",
            data: chunk,
          })
        );
      }

      voiceBufferLength = 0;
    }

    function handleVoiceMessage(event) {
      let data;

      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      if (data.type === "partial") {
        if (isThinking) return;
        // the microphone heard the assistant's own sentence: not the shopper, nothing is interrupted
        if (isEchoOfSpeech(data.text)) return;
        if (isSpeakingResponse || bargeGate.active()) {
          // only real words stop the assistant; an empty or noise-only result changes nothing
          if (!hasWords(data.text)) return;
          bargeGate.cancel();
          bargeInInterrupt();
        } else {
          interruptAssistant();
        }
        // recognised words so far: a new chunk adds to them, a "continued" message carries them all
        if (hasWords(data.text)) {
          liveCommitted = data.continued ? String(data.text).trim() : `${liveCommitted} ${String(data.text).trim()}`.trim();
          showLiveTranscript(liveCommitted);
        }
        status.textContent = ui("lblListen");
        return;
      }

      if (data.type === "interim" && typeof data.text === "string") {
        if (isThinking || isEchoOfSpeech(data.text)) return;
        if (isSpeakingResponse) {
          // words heard during a possible interruption: the shopper is really talking, stop the assistant for good
          if (!bargeCandidateUntil || !hasWords(data.text)) return;
          bargeGate.cancel();
          bargeInInterrupt();
        }
        showLiveTranscript(`${liveCommitted} ${data.text}`.trim());
        return;
      }

      // The call could not use the files that were attached to it.
      if (data.type === "files_error") {
        exitThinkingMode();
        showStatusAlert(typeof data.message === "string" && data.message ? data.message : ui("uploadFail"));
        return;
      }

      if (data.type === "lang" && ["en", "hi", "hinglish", ""].includes(data.lang)) {
        setPreferredLanguage(data.lang);
        try {
          saveChatState();
        } catch {}
        return;
      }

      if (data.type === "transcript" && typeof data.text === "string") {
        const transcript = data.text.trim();
        if (!transcript) return;

        enterThinkingMode(data.runId);
        lastMessageAt = Date.now();

        // The shopper went on talking after a pause: the server answers both parts as ONE question,
        // so the earlier part's bubble is replaced instead of shown twice.
        if (data.replaceLastUser) {
          const users = messages.querySelectorAll(".ai-commerce-chat-user:not(.is-live)");
          const previous = users[users.length - 1];
          if (previous) previous.remove();
          const lastHistoryUser = chatHistory.map((item) => item.role).lastIndexOf("user");
          if (lastHistoryUser !== -1) chatHistory.splice(lastHistoryUser, 1);
        }
        finishLiveTranscript(transcript);
        chatHistory.push({ role: "user", content: transcript });
        if (uiReady) applyUiLang();
        chatHistory.splice(0, Math.max(0, chatHistory.length - HISTORY_KEEP));
        return;
      }

      if (data.type === "answer" && typeof data.text === "string") {
        if (suppressVoiceAnswers && isStaleVoiceRun(data.runId)) {
          exitThinkingMode();
          return;
        }
        suppressVoiceAnswers = false;
        if (data.runId) lastAnswerRunId = data.runId;

        const finalAnswer = data.fallback ? ui("aiDown") : data.text.trim();

        void (async () => {
          if (suppressVoiceAnswers) return;
          const hasOrderPlacedAction =
            Array.isArray(data.actions) &&
            data.actions.some((a) => a?.type === "order_placed");

          // The reply is shown and spoken first; the cart updates run while it is being spoken.
          if (finalAnswer) {
            lastAgentReplyEl = addMessage(finalAnswer, "bot");
            chatHistory.push({ role: "assistant", content: finalAnswer });
            chatHistory.splice(0, Math.max(0, chatHistory.length - HISTORY_KEEP));
            lastAnswerText = finalAnswer;
            noteUnread();
            if (!data.hasServerAudio) {
              speakResponse(finalAnswer);
            } else if (status && isVoiceListening) {
              status.textContent = ui("voiceReceiving");
            }
          }
          await runCartActions(data.actions);

          // Spoken request for a person: the support module takes over (recording choice, then the audio call).
          const humanAsk = Array.isArray(data.actions) ? data.actions.find((a) => a && a.type === "human_support") : null;
          if (humanAsk) {
            setStaffWatch(true);
            root.dispatchEvent(new CustomEvent("ai-commerce:human-support", { detail: humanAsk }));
          }

          if (Array.isArray(data.products) && data.products.length > 0) {
            renderProductCards(data.products);
          }

          handleCheckoutActions(data.actions);
          if (data.checkout) checkoutState = data.checkout;
          if (
            Array.isArray(data.actions) &&
            data.actions.some((a) => a?.type === "order_placed" || a?.type === "clear_cart") &&
            checkoutState &&
            typeof checkoutState === "object"
          ) {
            checkoutState.appliedDiscount = null;
            checkoutState.discountAmount = 0;
            checkoutState.discountClearedAfterOrder = true;
            checkoutState.finalTotal = null;
            checkoutState.shippingMethod = "standard";
            checkoutState.shippingCost = 0;
            checkoutState.selectedPaymentMethod = null;
            checkoutState.paymentMethod = null;
            checkoutState.orderQuote = null;
            checkoutState.step = "cart";
            if (hasOrderPlacedAction && !customerLoggedIn) {
              checkoutState.shipping = null;
              checkoutState.billing = null;
              checkoutState.billingSameAsShipping = null;
              checkoutState.shippingConfirmed = false;
              checkoutState.billingConfirmed = false;
              checkoutState.customer = null;
              checkoutState.guestDetailsClearedAfterOrder = true;
            }
          }
          saveChatState();
          await refreshCartCount();
          const cart = await fetchCartSnapshot();
          if (cart && voiceSocket && voiceSocket.readyState === WebSocket.OPEN) {
            try {
              voiceSocket.send(
                JSON.stringify({
                  type: "cart_state",
                  cart,
                  clientId,
                  customerLoggedIn,
                  customer: storefrontCustomer,
                })
              );
            } catch {}
          }
        })();

        status.textContent = isVoiceListening ? "Listening… speak your next query." : "";
        return;
      }

      if (data.type === "audio" && typeof data.data === "string") {
        if (suppressVoiceAnswers && isStaleVoiceRun(data.runId)) {
          return;
        }
        playServerPcmAudio(data.data, 24000);
        return;
      }

      if (data.type === "audio_fallback") {
        if (lastAnswerText) {
          speakResponse(lastAnswerText);
        }
        return;
      }

      if (data.type === "error") {
        exitThinkingMode();
        console.error("Voice server error:", data.message);
        showStatusAlert(data.code === "voice_busy" ? ui("voiceBusy") : ui("voiceError"));
      }
    }

    // Which message fits why the browser refused the microphone (each one needs a different fix from the shopper).
    function micErrorKey(error) {
      const name = String((error && error.name) || "");
      if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "micDenied";
      if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "micNone";
      if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "micBusy";
      if (error && error.unsupported) return "micUnsupported";
      return "micFail";
    }

    // The microphone could not be used: say why (and how to fix it), mark the mic button as blocked, and put the shopper
    // straight back in the text box so the conversation goes on without it. Cleared the next time the mic works.
    function reportMicProblem(error) {
      const key = micErrorKey(error);
      showStatusAlert(ui(key));
      if (mic) {
        mic.classList.add("is-blocked");
        mic.dataset.blocked = key;
        mic.style.opacity = "0.55";
        mic.setAttribute("title", ui(key));
      }
      try { input && input.focus(); } catch {}
    }
    function clearMicProblem() {
      if (!mic || !mic.dataset.blocked) return;
      mic.classList.remove("is-blocked");
      delete mic.dataset.blocked;
      mic.style.opacity = "";
    }

    // The microphone is asked for FIRST, before anything is spoken, any token is fetched or "connected" is shown.
    async function acquireMicrophone() {
      if (!navigator.mediaDevices?.getUserMedia || (!window.AudioContext && !window.webkitAudioContext)) {
        const unsupported = new Error("Microphone capture is not supported in this browser.");
        unsupported.unsupported = true;
        throw unsupported;
      }
      return navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    }

    async function startAudioCapture(socket) {
      if (!mediaStream) mediaStream = await acquireMicrophone();
      // the microphone vanishing mid-call (unplugged, permission revoked) must end the call visibly, not leave a dead "listening" state
      for (const track of mediaStream.getAudioTracks()) {
        track.addEventListener("ended", () => {
          if (voiceSocket !== socket || (!isVoiceListening && !isVoiceConnecting)) return;
          showStatusAlert(ui("micLost"));
          stopVoice();
          if (mic) mic.disabled = false;
        });
      }

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioContext = new AudioContextClass();
      await audioContext.resume();

      sourceNode = audioContext.createMediaStreamSource(mediaStream);
      processorNode = audioContext.createScriptProcessor(MIC_FRAME_SAMPLES, 1, 1);
      silentGain = audioContext.createGain();
      silentGain.gain.value = 0;

      processorNode.onaudioprocess = (event) => {
        if (isMicMuted) {
          // Muted: not a single frame is sent and no barge-in can trigger.
          liveMicLevel = 0;
          return;
        }
        if (
          !isVoiceListening ||
          voiceSocket !== socket ||
          socket.readyState !== WebSocket.OPEN
        ) {
          return;
        }

        if (isThinking) {
          recentSpeech.length = 0;
          bargeInHits = 0;
          return;
        }

        const samples = event.inputBuffer.getChannelData(0);
        try {
          liveMicLevel = Math.min(1, computeRms(samples) * 8);
        } catch {}

        if (!isSpeakingResponse && Date.now() < micMutedUntil) return;

        if (isSpeakingResponse) {
          if (!ENABLE_BARGE_IN) return;

          const level = computeRms(samples);
          const frame = Float32Array.from(samples);

          // Deciding: is this the shopper talking (keeps going) or a short noise? The assistant keeps
          // speaking meanwhile and nothing is sent yet; the audio is kept so no word is lost.
          // A possible interruption is being written down by the server: the audio goes on to it, the assistant keeps talking.
          if (bargeCandidateUntil) {
            // The shopper is still talking while the words are being written down (the server can take a few seconds):
            // the decision window stays open as long as the voice goes on, up to a hard limit, so a real interruption
            // is not given up on just because the transcript was slow.
            if (Date.now() > bargeCandidateUntil && level > bargeIn.threshold() && Date.now() < bargeCandidateStartedAt + BARGE_CANDIDATE_MAX_MS) {
              bargeCandidateUntil = Date.now() + 400;
            }
            if (Date.now() > bargeCandidateUntil) {
              // no real words came: it was not an interruption, the assistant carries on
              bargeCandidateUntil = 0;
              resumeBrowserSpeech();
            } else queueVoiceChunk(socket, pcmToBase64(frame, audioContext.sampleRate));
            return;
          }
          if (bargeGate.active()) {
            recentSpeech.push(frame);
            if (bargeGate.frame(level > bargeIn.threshold()) === "stop") {
              const heard = recentSpeech.splice(0);
              if (browserVoiceSpeaking()) {
                // The browser's own voice is also heard by the microphone: the words decide whether this is the shopper.
                bargeCandidateStartedAt = Date.now();
                bargeCandidateUntil = bargeCandidateStartedAt + BARGE_CANDIDATE_MS;
                pauseBrowserSpeech(); // stops talking over the shopper right now; the words decide whether it stays stopped
              } else {
                bargeInInterrupt(); // stops the voice, switches to "User Speaking", tells the server
              }
              for (const chunk of heard) {
                queueVoiceChunk(socket, pcmToBase64(chunk, audioContext.sampleRate));
              }
            }
            return;
          }
          // Not enough voice in the window: it was a noise. Nothing happens.
          if (bargeGate.expired()) {
            bargeGate.cancel();
            recentSpeech.length = 0;
            resumeBrowserSpeech(); // it was only a noise: carry on from where it stopped
          }

          recentSpeech.push(frame);
          if (recentSpeech.length > BARGE_IN_PREROLL_CHUNKS) recentSpeech.shift();

          if (speakingChunks === 0) bargeIn.startReply({ strict: browserVoiceSpeaking() });
          speakingChunks++;

          if (bargeIn.hear(level)) {
            bargeGate.begin();
            // first sign of the shopper's voice: the assistant goes quiet this very frame (pausing costs nothing if it was noise)
            if (browserVoiceSpeaking()) pauseBrowserSpeech();
          }

          return;
        }

        recentSpeech.length = 0;
        bargeInHits = 0;
        speakingChunks = 0;
        echoLevel = 0;
        try {
          const quietLevel = computeRms(samples);
          bargeIn.observeQuiet(quietLevel);
          if (bargeIn.isVoice(quietLevel)) userTalkingUntil = Date.now() + USER_TALKING_HOLD_MS;
          const talking = isUserTalking();
          if (talking !== userTalkingShown) {
            userTalkingShown = talking;
            syncVoiceStrip();
          }
        } catch {}

        queueVoiceChunk(socket, pcmToBase64(samples, audioContext.sampleRate));
      };

      sourceNode.connect(processorNode);
      processorNode.connect(silentGain);
      silentGain.connect(audioContext.destination);
    }

    async function startVoice() {
      if (isVoiceConnecting || isVoiceListening) return;

      if (!apiUrl && !(await ensureApiUrl())) {
        showStatusAlert(ui("setupNeeded"));
        return;
      }

      let parsedApiUrl;
      try {
        parsedApiUrl = new URL(apiUrl);
      } catch {
        showStatusAlert(ui("setupNeeded"));
        return;
      }

      if (parsedApiUrl.protocol !== "https:") {
        showStatusAlert(ui("voiceHttps"));
        return;
      }

      const wsUrl = `wss://${parsedApiUrl.host}`;

      // 1. The microphone, before anything else. A refusal is explained and nothing is shown as connected or spoken.
      isVoiceConnecting = true;
      const startId = (voiceStartSeq += 1);
      setMicState("connecting");
      status.textContent = ui("micAsk");
      try {
        const stream = await acquireMicrophone();
        if (!isVoiceConnecting || startId !== voiceStartSeq) {
          // the shopper cancelled while the browser's permission prompt was open: let the microphone go again
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        mediaStream = stream;
        clearMicProblem();
      } catch (error) {
        console.error("Microphone request failed:", error);
        if (!isVoiceConnecting || startId !== voiceStartSeq) return;
        isVoiceConnecting = false;
        setMicState("idle");
        if (mic) mic.disabled = false;
        reportMicProblem(error);
        return;
      }

      let greetedNow = false;
      const isFreshChat =
        !window.__aiCommerceVoiceResume &&
        !messages.querySelector(".ai-commerce-chat-user") &&
        !chatHistory.some((item) => item.role === "user");

      if (isFreshChat) {
        greetedNow = true;
        voiceGreetingDone = true;
        suppressVoiceAnswers = false;
        // New chat + mic on: the AI's opening message (the one on screen, or fetched now; never a
        // second one) is spoken once. The shopper can interrupt it like any other reply.
        void showOpeningMessage().then((text) => {
          if (!text || openingSpokenText === text || !isVoiceListening && !isVoiceConnecting) return;
          openingSpokenText = text;
          suppressVoiceAnswers = false;
          speakResponse(text);
        });
      }

      isVoiceConnecting = true;
      status.textContent = ui("voiceConnecting");

      if (mic) mic.disabled = true;
      setMicState("connecting");

      try {
        let voiceToken;

        try {
          const tokenResponse = await fetch("/apps/ai-agent/voice-token", {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ purpose: "voice" }),
          });
          const tokenData = await tokenResponse.json().catch(() => ({}));

          if (!tokenResponse.ok || typeof tokenData.token !== "string") {
            throw new Error(tokenData.error || "Voice authorization failed.");
          }

          voiceToken = tokenData.token;
        } catch (error) {
          console.error("Voice token request failed:", error);
          showStatusAlert(ui("voiceUnavailable"));
          stopVoice();
          if (mic) mic.disabled = false;
          return;
        }

        // the token goes in the subprotocol, never the URL (URLs end up in proxy and access logs)
        const socket = new WebSocket(`${wsUrl}/`, ["orbi.voice.v1", `orbi.token.${voiceToken}`]);
        voiceSocket = socket;

        socket.addEventListener("message", handleVoiceMessage);

        socket.addEventListener("open", async () => {
          if (voiceSocket !== socket) return;

          try {
            try {
              socket.send(
                JSON.stringify({
                  type: "resume",
                  history: chatHistory.slice(-12),
                  clientId,
                  customerLoggedIn,
                  customer: storefrontCustomer,
                })
              );
            } catch {}

            await startAudioCapture(socket);

            isVoiceConnecting = false;
            isVoiceListening = true;
            voiceSessionReady = true;
            sendBufferedAudio();

            if (preferredLanguage) {
              try {
                socket.send(JSON.stringify({ type: "lang_state", lang: preferredLanguage }));
              } catch {}
            }

            if (mic) mic.disabled = false;
            setMicState("listening");
            try {
              localStorage.setItem(uiStateKey("voice"), String(Date.now()));
            } catch {}

            status.textContent = ui("voiceConnected");

            if (greetedNow) {
              voiceGreetingDone = true;
              if (status) status.textContent = ui("lblListen");
            } else {
              voiceGreetingDone = true;
              try {
                const rawPending = localStorage.getItem(uiStateKey("pendingSpeech"));
                if (rawPending) {
                  const pending = JSON.parse(rawPending);
                  if (pending && pending.text && Date.now() - (pending.at || 0) < 120000) {
                    localStorage.removeItem(uiStateKey("pendingSpeech"));
                    window.setTimeout(() => {
                      if (!suppressVoiceAnswers) {
                        speakResponse(pending.text);
                      }
                    }, 600);
                  }
                }
              } catch {}
            }
            window.__aiCommerceVoiceResume = false;

            void (async () => {
              const cart = await fetchCartSnapshot();
              if (cart && voiceSocket === socket && socket.readyState === WebSocket.OPEN) {
                try {
                  socket.send(
                    JSON.stringify({
                      type: "cart_state",
                      cart,
                      clientId,
                      customerLoggedIn,
                      customer: storefrontCustomer,
                    })
                  );
                } catch {}
              }
            })();
          } catch (error) {
            console.error("Voice microphone setup failed:", error);
            reportMicProblem(error);
            stopVoice();
            if (mic) mic.disabled = false;
          }
        });

        socket.addEventListener("error", () => {
          showStatusAlert(ui("voiceConnectFail"));
        });

        socket.addEventListener("close", () => {
          if (voiceSocket !== socket) return;
          stopVoice({ closeSocket: false });
          if (mic) mic.disabled = false;
          if (!status.textContent) {
            showStatusAlert(ui("voiceDisconnected"));
          }
        });
      } catch (error) {
        console.error("Voice startup error:", error);
        showStatusAlert(ui("voiceStartFail"));
        stopVoice();
        if (mic) mic.disabled = false;
      }
    }

    if (mic) {
      mic.addEventListener("click", () => {
        if (isVoiceConnecting || isVoiceListening) {
          stopVoice({ userInitiated: true });
          status.textContent = ui("voiceStopped");
          return;
        }
        startVoice();
      });
    }

    toggle.addEventListener("click", () => {
      if (isMinimized && !panel.hidden) {
        setMinimized(false);
        input.focus();
        return;
      }
      setOpen(panel.hidden);
    });

    if (minimizeBtn) {
      minimizeBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setMinimized(true);
      });
    }

    if (backBtn) {
      backBtn.addEventListener("click", () => setOpen(false));
    }

    close.addEventListener("click", () => {
      setOpen(false);
      toggle.focus();
    });

    send.addEventListener("click", (event) => {
      if (replyInFlight && stopCurrentReply) {
        event.preventDefault();
        stopCurrentReply();
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      const message = input.value.trim();
      const pendingFiles = files.slice();
      if ((!message && !pendingFiles.length) || replyInFlight) return;
      // "." or "?!" carries nothing to answer: it is not sent to the assistant (emoji and any language's letters and digits still are)
      if (!pendingFiles.length && !/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(message)) {
        input.value = "";
        status.textContent = ui("emptyMsg");
        return;
      }
      // the same text sent twice within moments (a double tap, a repeated Enter) is one message
      const nowMs = Date.now();
      if (!pendingFiles.length && message === lastSentText && nowMs - lastSentAt < 2500) {
        input.value = "";
        return;
      }
      lastSentText = message;
      lastSentAt = nowMs;

      // when the shopper last wrote (sent only as a backup: the server keeps its own record)
      const previousMessageAt = lastMessageAt;
      lastMessageAt = Date.now();
      const userBubble = addMessage(message, "user");
      if (pendingFiles.length) attachGrid(userBubble, pendingFiles);
      clearFiles(true);
      suggestSeq += 1;
      renderChips([]);
      input.value = "";
      status.textContent = "";

      // Text chat goes through the app proxy and needs no backend address; only voice and file uploads use it, and
      // uploadAttachments() looks it up itself. A proxy lookup that failed once must not stop a shopper from typing.

      const originalButtonHtml = send.innerHTML;
      // The text box stays usable (the next message can be written meanwhile); the send button turns into a stop button.
      replyInFlight = true;
      stoppedByShopper = false;
      send.setAttribute("aria-label", "Stop");
      enterThinkingMode();
      pendingReply = true;
      refreshLive();
      send.textContent = "■";
      status.textContent = ui("lblThink");

      const typingMessage = addMessage(ui("lblThink"), "bot");
      const epoch = chatEpoch;
      const stale = () => epoch !== chatEpoch;
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      let timedOut = false;
      stopCurrentReply = () => {
        stoppedByShopper = true;
        if (controller) controller.abort();
      };
      const timer = window.setTimeout(() => {
        timedOut = true;
        if (controller) controller.abort();
      }, chatTimeoutMs());

      try {
        const uploaded = pendingFiles.length ? await uploadAttachments(pendingFiles) : [];
        const cart = await fetchCartSnapshot();
        const response = await fetch("/apps/ai-agent/chat", {
          method: "POST",
          signal: controller ? controller.signal : undefined,
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message,
            attachments: uploaded.length ? uploaded.map((item) => item.id) : undefined,
            history: chatHistory,
            cart,
            checkout: checkoutState,
            clientId,
            customerLoggedIn,
            customer: storefrontCustomer,
            languageChoice: preferredLanguage || undefined,
            lastActivityAt: previousMessageAt || undefined,
          }),
        });

        const data = await response.json().catch(() => ({}));
        // The conversation was cleared while this reply was on its way: it belongs to a chat that no longer exists.
        if (stale()) {
          typingMessage.remove();
          return;
        }

        if (!response.ok) {
          const failure = new Error(data.error || "The request could not be completed.");
          failure.busy = response.status === 429;
          throw failure;
        }
        adoptClientId(data.clientId);
        tagCartWithChat(data.chatRef, Array.isArray(data.actions) && data.actions.some((a) => a && a.type === "add_to_cart"));

        // A person from the store has this chat: the AI says nothing, the team's reply will arrive on its own.
        if (data.handedOff) {
          exitThinkingMode();
          typingMessage.remove();
          chatHistory.push({ role: "user", content: message || `[${pendingFiles.length} attachment(s)]` });
          if (uiReady) applyUiLang(); // the chat's own labels follow the language the shopper is writing in
          chatHistory.splice(0, Math.max(0, chatHistory.length - HISTORY_KEEP));
          showTeamStrip(true);
          setStaffWatch(true);
          saveChatState();
          return;
        }
        // The AI asked for a person: someone may join soon, so start listening for them.
        if (Array.isArray(data.actions) && data.actions.some((a) => a && a.type === "flag_for_owner")) setStaffWatch(true);
        // The shopper asked for a person: the support module shows the recording choice and connects the call.
        const humanAsk = Array.isArray(data.actions) ? data.actions.find((a) => a && a.type === "human_support") : null;
        if (humanAsk) {
          setStaffWatch(true);
          root.dispatchEvent(new CustomEvent("ai-commerce:human-support", { detail: humanAsk }));
        }

        // no AI could answer: say so in the shopper's language (the server's stand-in is English)
        const finalAnswer = data.fallback
          ? ui("aiDown")
          : typeof data.answer === "string" && data.answer.trim()
            ? data.answer.trim()
            : ui("noReply");

        exitThinkingMode();

        // Always render the exact response returned by the agent (never overwrite with "Your cart is now empty.")
        renderFormattedBotText(typingMessage, finalAnswer);
        lastAgentReplyEl = typingMessage;

        chatHistory.push({ role: "user", content: message || `[${pendingFiles.length} attachment(s)]` });
        if (uiReady) applyUiLang(); // the chat's own labels follow the language the shopper is writing in
        chatHistory.splice(0, Math.max(0, chatHistory.length - HISTORY_KEEP));
        noteUnread();
        void loadSuggestions(message, finalAnswer);

        // Speak first; the cart updates run while the reply is being spoken.
        speakResponse(finalAnswer);
        await runCartActions(data.actions);
        const hasOrderPlacedAction =
          Array.isArray(data.actions) &&
          data.actions.some((a) => a?.type === "order_placed");

        if (Array.isArray(data.products) && data.products.length > 0) {
          renderProductCards(data.products);
        }

        chatHistory.push({ role: "assistant", content: finalAnswer });
        chatHistory.splice(0, Math.max(0, chatHistory.length - HISTORY_KEEP));
        handleCheckoutActions(data.actions);
        if (data.checkout) checkoutState = data.checkout;
        if (typeof data.languageChoice === "string") {
          setPreferredLanguage(data.languageChoice);
        }
        if (
          Array.isArray(data.actions) &&
          data.actions.some((a) => a?.type === "order_placed" || a?.type === "clear_cart") &&
          checkoutState &&
          typeof checkoutState === "object"
        ) {
          checkoutState.appliedDiscount = null;
          checkoutState.discountAmount = 0;
          checkoutState.discountClearedAfterOrder = true;
          checkoutState.finalTotal = null;
          checkoutState.shippingMethod = "standard";
          checkoutState.shippingCost = 0;
          checkoutState.selectedPaymentMethod = null;
          checkoutState.paymentMethod = null;
          checkoutState.orderQuote = null;
          checkoutState.step = "cart";
          if (hasOrderPlacedAction && !customerLoggedIn) {
            checkoutState.shipping = null;
            checkoutState.billing = null;
            checkoutState.billingSameAsShipping = null;
            checkoutState.shippingConfirmed = false;
            checkoutState.billingConfirmed = false;
            checkoutState.customer = null;
            checkoutState.guestDetailsClearedAfterOrder = true;
          }
        }
        if (voiceSocket && voiceSocket.readyState === WebSocket.OPEN) {
          try {
            voiceSocket.send(
              JSON.stringify({
                type: "sync_history",
                history: chatHistory.slice(-12),
                clientId,
                customerLoggedIn,
                customer: storefrontCustomer,
              })
            );
          } catch {}
        }
        saveChatState();
        void refreshCartCount();
      } catch (error) {
        (timedOut || (error && error.name === "AbortError") ? console.warn : console.error)("AI shopping chat error:", error);
        if (stale()) {
          typingMessage.remove();
        } else if (stoppedByShopper) {
          // The shopper pressed stop: nothing is shown as an error; the message goes back into the box to edit or send again.
          typingMessage.remove();
          if (!input.value.trim()) input.value = message;
        } else if (timedOut || (error && error.name === "AbortError")) {
          // No answer in time: say so, and let the shopper send the same message again with one tap.
          typingMessage.textContent = ui("chatTimeout");
          const retry = document.createElement("button");
          retry.type = "button";
          retry.className = "ai-commerce-chat-retry";
          retry.textContent = ui("retry");
          retry.addEventListener("click", () => {
            if (replyInFlight || stale()) return;
            typingMessage.remove();
            userBubble.remove();
            lastSentAt = 0; // a retry is never a duplicate
            input.value = message;
            if (typeof form.requestSubmit === "function") form.requestSubmit();
          });
          typingMessage.appendChild(document.createElement("br"));
          typingMessage.appendChild(retry);
        } else {
          typingMessage.textContent =
            error && error.busy
              ? ui("busy")
              : error && error.message && /upload|file/i.test(error.message)
                ? error.message
                : ui("connectFail");
        }
      } finally {
        window.clearTimeout(timer);
        pendingReply = false;
        refreshLive();
        exitThinkingMode();
        replyInFlight = false;
        stopCurrentReply = null;
        send.removeAttribute("aria-label");
        send.innerHTML = originalButtonHtml;
        status.textContent = "";
        input.focus();
      }
    });

    if (menuBtn && menuPanel) {
      menuBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleMenu();
      });

      menuPanel.addEventListener("click", (event) => {
        event.stopPropagation();
      });

      document.addEventListener("click", (event) => {
        if (!menuPanel.hidden && !root.contains(event.target)) {
          closeMenu();
        } else if (
          !menuPanel.hidden &&
          !menuBtn.contains(event.target) &&
          !menuPanel.contains(event.target)
        ) {
          closeMenu();
        }
      });

      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeMenu();
      });
    }

    // ---- A person from the store can join the chat. Their replies are picked up here. ----
    const STAFF_WATCH_MS = 24 * 60 * 60 * 1000;
    let staffSince = "";
    let staffTimer = null;
    let staffPolling = false;
    let teamStrip = null;

    function staffWatching() {
      try {
        const stamp = Number(localStorage.getItem(uiStateKey("staff")) || 0);
        return stamp > 0 && Date.now() - stamp < STAFF_WATCH_MS;
      } catch {
        return false;
      }
    }

    function showTeamStrip(on) {
      if (!teamStrip) {
        teamStrip = document.createElement("div");
        teamStrip.className = "ai-commerce-team-strip";
        teamStrip.setAttribute("role", "status");
        teamStrip.textContent = ui("teamOn");
        teamStrip.hidden = true;
        if (form && form.parentNode) form.parentNode.insertBefore(teamStrip, form);
      }
      teamStrip.hidden = !on;
    }

    function stopStaffPoll() {
      if (staffTimer) clearTimeout(staffTimer);
      staffTimer = null;
    }

    function scheduleStaffPoll(delay) {
      stopStaffPoll();
      if (!staffWatching()) return;
      const open = !panel.hidden && document.visibilityState !== "hidden";
      staffTimer = setTimeout(pollStaff, typeof delay === "number" ? delay : open ? 6000 : 20000);
    }

    function setStaffWatch(on) {
      try {
        if (on) localStorage.setItem(uiStateKey("staff"), String(Date.now()));
        else localStorage.removeItem(uiStateKey("staff"));
      } catch {}
      if (on) scheduleStaffPoll(); else stopStaffPoll();
    }

    function addTeamMessage(text) {
      const bubble = addMessage(text, "bot", { stream: false });
      bubble.classList.add("ai-commerce-chat-staff");
      bubble.dataset.staff = "1";
      saveChatState();
      return bubble;
    }

    async function pollStaff() {
      if (staffPolling || !clientId) return scheduleStaffPoll();
      staffPolling = true;
      try {
        const response = await fetch("/apps/ai-agent/staff-messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId, since: staffSince || undefined }),
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data) {
          const fresh = Array.isArray(data.messages) ? data.messages : [];
          fresh.forEach((item) => {
            if (!item || typeof item.text !== "string" || !item.text.trim()) return;
            if (item.at && (!staffSince || item.at > staffSince)) staffSince = item.at;
            const teamBubble = addTeamMessage(item.text);
            if (item.call) root.dispatchEvent(new CustomEvent("ai-commerce:call-summary", { detail: { item, bubble: teamBubble } }));
            chatHistory.push({ role: "assistant", content: item.text });
            chatHistory.splice(0, Math.max(0, chatHistory.length - HISTORY_KEEP));
            noteUnread();
          });
          showTeamStrip(Boolean(data.handedOff));
          // nothing is waiting for a person any more: stop asking
          if (data.watch === false) {
            setStaffWatch(false);
            return;
          }
        }
      } catch {
        // offline or a hiccup: try again on the next round
      } finally {
        staffPolling = false;
      }
      scheduleStaffPoll();
    }

    // coming back to the tab, or opening the chat, looks right away
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && staffWatching()) scheduleStaffPoll(500);
    });
    if (staffWatching()) scheduleStaffPoll(1500);

    async function maybeResumeVoice() {
      let stamp = 0;
      try {
        stamp = Number(localStorage.getItem(uiStateKey("voice")) || 0);
      } catch {}
      if (!stamp || stamp === 0 || Date.now() - stamp > 120000) return;
      if (panel.hidden) return;

      let perm = "granted";
      try {
        if (navigator.permissions?.query) {
          const micStatus = await navigator.permissions.query({ name: "microphone" });
          perm = micStatus.state;
        }
      } catch {}

      if (perm !== "granted") {
        if (status) {
          status.textContent = ui("voiceStillHere");
        }
        return;
      }

      if (status) status.textContent = ui("voiceReconnecting");
      window.__aiCommerceVoiceResume = true;
      voiceGreetingDone = true;
      window.setTimeout(() => {
        if (!panel.hidden && !isVoiceListening && !isVoiceConnecting) {
          startVoice();
        }
      }, 400);
    }


    // ---- Suggestion chips: written by the AI after every reply (varied, in context). ----
    let suggestSeq = 0;
    let recentChips = [];
    // The AI writes the chips from the last exchange. They arrive a moment after the reply, never delaying it.
    async function loadSuggestions(lastUser, answer) {
      const seq = ++suggestSeq;
      try {
        const response = await fetch("/apps/ai-agent/suggestions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ lastUser, answer, recent: recentChips.slice(-10), languageChoice: preferredLanguage || undefined, clientId }),
        });
        const data = await response.json().catch(() => ({}));
        if (seq !== suggestSeq || !response.ok || !Array.isArray(data.suggestions)) return;
        recentChips = recentChips.concat(data.suggestions).slice(-10);
        renderChips(data.suggestions);
      } catch {}
    }

    function renderChips(list) {
      lastChips = Array.isArray(list) ? list.filter((s) => typeof s === "string" && s.trim()).slice(0, 4) : [];
      if (!chipsBox) return;
      chipsBox.innerHTML = "";
      const items = lastChips.map((text) => ({ text, message: text }));
      if (files.some((f) => f.kind === "image")) items.unshift({ text: ui("findSimilar"), message: ui("findSimilarMsg") });
      items.forEach((item, i) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "ai-commerce-chat-chip";
        chip.style.setProperty("--i", String(i));
        chip.textContent = item.text;
        chip.addEventListener("click", () => submitMessage(item.message));
        chipsBox.appendChild(chip);
      });
      chipsBox.hidden = items.length === 0;
    }

    function submitMessage(text) {
      if (replyInFlight || (!text && !files.length)) return;
      input.value = text;
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    }

    // ---- Attachments: photos, videos and PDFs (up to 10), sent with the message to the agent and the store team. ----
    const MAX_FILES = 10;
    const MAX_BYTES = { image: 8 * 1024 * 1024, pdf: 10 * 1024 * 1024, video: 15 * 1024 * 1024 };
    let files = [];
    let fileSeq = 0;

    const fileKind = (file) => (file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type === "application/pdf" ? "pdf" : "");

    function fileTile(entry, removable) {
      const tile = document.createElement("div");
      tile.className = "ai-commerce-file";
      if (entry.url && (entry.kind === "image" || entry.kind === "video")) {
        const media = document.createElement(entry.kind === "image" ? "img" : "video");
        media.src = entry.url;
        if (entry.kind === "image") media.alt = entry.name;
        else media.muted = true;
        tile.appendChild(media);
        if (entry.kind === "video") {
          const tag = document.createElement("span");
          tag.className = "ai-commerce-file-kind";
          tag.textContent = ui("videoTag");
          tile.appendChild(tag);
        }
      } else {
        const doc = document.createElement("span");
        doc.className = "ai-commerce-file-doc";
        doc.textContent = entry.kind === "image" ? "IMG" : entry.kind === "video" ? "VIDEO" : "PDF";
        if (entry.name) tile.title = entry.name;
        tile.appendChild(doc);
      }
      if (removable) {
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "ai-commerce-file-rm";
        rm.setAttribute("aria-label", `${ui("removeOne")} ${entry.name}`);
        rm.textContent = "✕";
        rm.addEventListener("click", () => dropFile(entry.id));
        tile.appendChild(rm);
      }
      return tile;
    }

    function renderTray(note) {
      if (!tray) return;
      trayFiles.innerHTML = "";
      files.forEach((entry) => trayFiles.appendChild(fileTile(entry, true)));
      tray.hidden = files.length === 0;
      if (trayNote) trayNote.textContent = note || (files.length ? ui("attached", { n: files.length, max: MAX_FILES }) : "");
      if (input && !(isVoiceListening || isVoiceConnecting)) input.placeholder = placeholderText();
      renderChipsKeepList();
    }

    function renderChipsKeepList() {
      if (chipsBox) renderChips(lastChips);
    }

    function addFiles(list) {
      let note = "";
      Array.from(list || []).forEach((file) => {
        const kind = fileKind(file);
        if (!kind) { note = ui("badType", { name: file.name }); return; }
        if (file.size > MAX_BYTES[kind]) { note = ui("tooBig", { name: file.name }); return; }
        if (files.length >= MAX_FILES) { note = ui("tooMany", { max: MAX_FILES }); return; }
        files.push({ id: ++fileSeq, file, kind, url: URL.createObjectURL(file), name: file.name || kind });
      });
      renderTray(note);
    }

    function dropFile(id) {
      files = files.filter((entry) => {
        if (entry.id !== id) return true;
        try { URL.revokeObjectURL(entry.url); } catch {}
        return false;
      });
      renderTray();
    }

    // keepUrls: the sent message still shows these thumbnails, so their object URLs stay alive.
    function clearFiles(keepUrls) {
      if (!keepUrls) files.forEach((entry) => { try { URL.revokeObjectURL(entry.url); } catch {} });
      files = [];
      if (fileInput) fileInput.value = "";
      renderTray();
    }

    function attachGrid(bubble, entries) {
      const grid = document.createElement("div");
      grid.className = "ai-commerce-attach-grid";
      entries.forEach((entry) => grid.appendChild(fileTile(entry, false)));
      bubble.insertBefore(grid, bubble.firstChild);
      bubble._files = entries.map(({ name, kind, size }) => ({ name, kind, size }));
      if (!restoringState) saveChatState();
    }

    // Files go straight to the backend (the Shopify app proxy is not meant for large bodies),
    // authorised with the same short-lived, shop-bound token the voice session uses.
    async function uploadAttachments(entries) {
      // a fresh one-time upload token for every upload
      const tokenResponse = await fetch("/apps/ai-agent/voice-token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "upload" }) });
      const tokenData = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok || typeof tokenData.token !== "string") throw new Error(ui(tokenResponse.status === 429 ? "busy" : "uploadFail"));
      const body = new FormData();
      body.append("clientId", clientId || "");
      entries.forEach((entry) => body.append("files", entry.file, entry.name));
      const backend = apiUrl || (await ensureApiUrl());
      if (!backend) throw new Error(ui("uploadFail"));
      const response = await fetch(`${String(backend).replace(/\/$/, "")}/api/uploads`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenData.token}` },
        body,
      });
      const data = await response.json().catch(() => ({}));
      // the server answers with a code; the words are the widget's own, in the shopper's language
      const byCode = { rate_limited: "busy", store_busy: "busy", uploads_busy: "busy", quota_full: "uploadFull", scanner_unavailable: "uploadCheck" };
      if (response.status === 429 || byCode[data.code]) throw new Error(ui(byCode[data.code] || "busy"));
      if (!response.ok || !Array.isArray(data.attachments)) throw new Error(data.error || ui("uploadFail"));
      return data.attachments;
    }

    // On a live call there is no message box: files picked now go to the call straight away.
    function inLiveCall() {
      return Boolean(isVoiceListening && voiceSocket && voiceSocket.readyState === WebSocket.OPEN && panel.classList.contains("is-voice-live"));
    }

    async function sendCallFiles() {
      const pending = files.slice();
      if (!pending.length || !inLiveCall()) return;
      const bubble = addMessage("", "user");
      attachGrid(bubble, pending);
      clearFiles(true);
      lastMessageAt = Date.now();
      enterThinkingMode();
      status.textContent = ui("sendingFiles");
      try {
        const uploaded = await uploadAttachments(pending);
        if (!inLiveCall()) throw new Error(ui("uploadFail"));
        chatHistory.push({ role: "user", content: `[${pending.length} attachment(s)]` });
        chatHistory.splice(0, Math.max(0, chatHistory.length - HISTORY_KEEP));
        voiceSocket.send(JSON.stringify({ type: "attachments", ids: uploaded.map((item) => item.id) }));
        saveChatState();
      } catch (error) {
        exitThinkingMode();
        bubble.remove();
        showStatusAlert(error && error.message ? error.message : ui("uploadFail"));
      }
    }

    function filesPicked(list) {
      addFiles(list);
      if (inLiveCall()) void sendCallFiles();
    }

    if (attachBtn && fileInput) {
      attachBtn.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", () => { filesPicked(fileInput.files); fileInput.value = ""; });
    }
    if (voiceAttach && fileInput) voiceAttach.addEventListener("click", () => fileInput.click());
    if (trayClear) trayClear.addEventListener("click", () => clearFiles(false));
    if (input) {
      input.addEventListener("paste", (event) => {
        const pasted = Array.from(event.clipboardData?.files || []);
        if (pasted.length) { event.preventDefault(); addFiles(pasted); }
      });
    }
    ["dragenter", "dragover"].forEach((name) => panel.addEventListener(name, (event) => {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes("Files")) return;
      event.preventDefault();
      panel.classList.add("is-dropping");
    }));
    ["dragleave", "drop"].forEach((name) => panel.addEventListener(name, (event) => {
      if (name === "dragleave" && panel.contains(event.relatedTarget)) return;
      panel.classList.remove("is-dropping");
      if (name === "drop" && event.dataTransfer?.files?.length) {
        event.preventDefault();
        filesPicked(event.dataTransfer.files);
      }
    }));

    // ---- Clear chat: the shopper's screen is cleared, the store keeps its copy, the cart is untouched. ----
    function openClearConfirm() {
      closeMenu();
      if (!confirmBox) return;
      confirmBox.hidden = false;
      confirmNo?.focus({ preventScroll: true });
    }

    function closeClearConfirm() {
      if (confirmBox) confirmBox.hidden = true;
    }

    function clearChat() {
      closeClearConfirm();
      chatEpoch += 1;
      if (isVoiceListening || isVoiceConnecting) stopVoice({ userInitiated: true });
      clearFiles(false);
      suggestSeq += 1;
      recentChips = [];
      renderChips([]);
      Array.from(messages.children).forEach((child, i) => child.style.setProperty("--d", String(i * 40)));
      messages.classList.add("is-clearing");
      window.setTimeout(() => {
        messages.classList.remove("is-clearing");
        resetConversation();
        messages.classList.add("is-fresh");
        window.setTimeout(() => messages.classList.remove("is-fresh"), 450);
        showCartToast(ui("cleared"));
      }, 380);
    }

    if (clearBtn) clearBtn.addEventListener("click", openClearConfirm);
    if (confirmNo) confirmNo.addEventListener("click", closeClearConfirm);
    if (confirmYes) confirmYes.addEventListener("click", clearChat);
    if (confirmBox) confirmBox.addEventListener("click", (event) => { if (event.target === confirmBox) closeClearConfirm(); });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && confirmBox && !confirmBox.hidden) closeClearConfirm();
    });

    uiReady = true;
    applyUiLang();
    if (panelAway()) startTeaser(3500);

    restoreChatState();
    restoreUiState();
    if (!panel.hidden && chatIsEmpty()) void showOpeningMessage();
    setMicState("idle");
    void refreshCartCount();
    void maybeResumeVoice();

    window.setInterval(() => {
      if (pageLeaving || !panel || panel.hidden) return;
      try {
        localStorage.setItem(uiStateKey("open"), "1");
        sessionStorage.setItem(uiStateKey("open"), "1");
        writeFlagCookie(uiStateKey("open"), "1");
        if (isVoiceListening) localStorage.setItem(uiStateKey("voice"), String(Date.now()));
      } catch {}
    }, 1500);

    document.addEventListener(
      "click",
      (event) => {
        const link = event.target?.closest?.("a[href]");
        if (!link || !panel || panel.hidden) return;
        if (link.target === "_blank" || link.hasAttribute("download")) return;
        let url;
        try {
          url = new URL(link.href, window.location.href);
        } catch {
          return;
        }
        if (url.origin !== window.location.origin) return;
        try {
          localStorage.setItem(uiStateKey("open"), "1");
          sessionStorage.setItem(uiStateKey("open"), "1");
          writeFlagCookie(uiStateKey("open"), "1");
          if (isVoiceListening) localStorage.setItem(uiStateKey("voice"), String(Date.now()));
          saveChatState();
        } catch {}
      },
      true
    );

    window.addEventListener("pagehide", () => {
      pageLeaving = true;
      const isOpenNow = !!(panel && !panel.hidden);
      try {
        localStorage.setItem(uiStateKey("open"), isOpenNow ? "1" : "0");
        sessionStorage.setItem(uiStateKey("open"), isOpenNow ? "1" : "0");
        writeFlagCookie(uiStateKey("open"), isOpenNow ? "1" : "0");
        if (isVoiceListening || isVoiceConnecting) {
          localStorage.setItem(uiStateKey("voice"), String(Date.now()));
        }
        if (isSpeakingResponse && window.__aiCommerceLastSpeech) {
          localStorage.setItem(
            uiStateKey("pendingSpeech"),
            JSON.stringify({ text: window.__aiCommerceLastSpeech, at: Date.now() })
          );
        }
        saveChatState();
      } catch {}
      stopVoice({ closeSocket: true, userInitiated: false });
    });

    window.addEventListener("beforeunload", () => {
      pageLeaving = true;
      if ((panel && !panel.hidden) || readUiFlag("open")) {
        try {
          localStorage.setItem(uiStateKey("open"), "1");
          sessionStorage.setItem(uiStateKey("open"), "1");
          writeFlagCookie(uiStateKey("open"), "1");
        } catch {}
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && panel && !panel.hidden) {
        try {
          localStorage.setItem(uiStateKey("open"), "1");
          sessionStorage.setItem(uiStateKey("open"), "1");
          if (isVoiceListening) localStorage.setItem(uiStateKey("voice"), String(Date.now()));
        } catch {}
      }
    });

    window.addEventListener("pageshow", () => {
      restoreUiState();
    });

    document.addEventListener("shopify:section:load", () => {
      restoreUiState();
    });

    // What the live-support module (ai-chat-widget-support.js) needs from the chat. Nothing else of the chat is shared.
    root.__aiCommerceBridge = {
      panel,
      messages,
      get apiUrl() { return apiUrl; },
      ensureApiUrl,
      getClientId: () => clientId,
      // The support messages follow the chat: Hindi when chosen, Hinglish when the shopper has been writing Hinglish (the chat's own
      // labels stay English then), else English. A Hinglish chat got every support message in English (live, 2026-11-22).
      uiLang,
      scrollToBottom: (force) => safeScrollMessagesToBottom(Boolean(force)),
      // the AI voice session must not listen to a call with a person
      stopVoice: () => {
        if (isVoiceListening || isVoiceConnecting) stopVoice({ closeSocket: true, userInitiated: false });
      },
      pollSoon: () => {
        setStaffWatch(true);
        scheduleStaffPoll(400);
      },
    };
    // No address in the theme setting: learn it now, so the live-help socket and uploads have it by the time they are used.
    if (!apiUrl) ensureApiUrl();
    root.dispatchEvent(new CustomEvent("ai-commerce:bridge"));
  }

  function start() {
    document.querySelectorAll(".ai-commerce-chat-root").forEach(initChat);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();