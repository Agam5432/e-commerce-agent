import { customerText } from "../utils/logger.js";
import "dotenv/config";
import { GoogleGenAI, Modality } from "@google/genai";

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_API;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY (or GEMINI_API) is missing in .env");
  }

  return new GoogleGenAI({ apiKey });
}

export async function connectGeminiLive(onTranscript, { onClose, onEvent = () => {}, manualActivity = false } = {}) {
  const ai = getGeminiClient();

  if (typeof onTranscript !== "function") {
    throw new Error("A transcript callback is required.");
  }

  const MAX_TRANSCRIPT_LENGTH = 2000;
  const liveModel =
    process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview";

  // Native-audio / 3.1 live models require AUDIO response modality (otherwise code 1007 closes the socket),
  // while still delivering text inputAudioTranscription chunks via serverContent.inputTranscription.text!
  const needsAudioModality = /3\.1|native-audio/i.test(liveModel);
  const responseModalities = needsAudioModality
    ? [Modality.AUDIO]
    : [Modality.TEXT];

  console.log("[Gemini Live] Connecting with model:", liveModel);

  const session = await ai.live.connect({
    model: liveModel,

    config: {
      responseModalities,
      inputAudioTranscription: {},
      // This connection only writes down what the shopper says; the store's own agent answers. A live model that also talks
      // (it must, with AUDIO output) keeps its replies to nothing, so it is not busy speaking when the next words arrive.
      systemInstruction: { parts: [{ text: "You are a silent transcription relay. Never answer, never speak, never comment. Produce no reply at all." }] },

      realtimeInputConfig: manualActivity
        // the server says when the shopper starts and stops talking (see liveSessionManager.js)
        ? { automaticActivityDetection: { disabled: true } }
        : {
        automaticActivityDetection: {
          // end of speech after 0.9 s of silence (the server adds only a short wait after this)
          silenceDurationMs: 900,
          prefixPaddingMs: 100,
          endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
          startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
        },
        },
    },

    callbacks: {
      onopen: () => {
        console.log("[Gemini Live] Connected successfully.");
        onEvent({ e: "open" });
      },

      onmessage: (message) => {
        const content = message?.serverContent;
        // what Gemini sent, without its words (for the voice diagnostics a test can ask the socket for)
        try {
          const keys = Object.keys(message || {}).filter((k) => message[k] != null);
          const parts = content ? Object.keys(content).filter((k) => content[k] != null && content[k] !== false) : [];
          onEvent({ e: "msg", keys: keys.join(","), content: parts.join(","), heard: content?.inputTranscription?.text ? String(content.inputTranscription.text).length : 0 });
        } catch { /* diagnostics only */ }

        const interimText = content?.interimInputTranscription?.text;

        if (typeof interimText === "string" && interimText.trim()) {
          // shown live in the chat while the shopper is still talking (never answered)
          Promise.resolve()
            .then(() => onTranscript(interimText.trim().slice(0, MAX_TRANSCRIPT_LENGTH), { interim: true }))
            .catch(() => {});
        }

        const rawTranscript = content?.inputTranscription?.text;

        const turnComplete = Boolean(
          content?.turnComplete || content?.inputTranscription?.finished
        );

        if (typeof rawTranscript !== "string") {
          if (turnComplete) {
            Promise.resolve()
              .then(() => onTranscript("", { turnComplete: true }))
              .catch((error) => {
                console.error(
                  "[Gemini Live] Turn-complete callback failed:",
                  error?.message || error
                );
              });
          }

          return;
        }

        const transcript = rawTranscript.trim();

        if (!transcript || transcript.length > MAX_TRANSCRIPT_LENGTH) {
          if (transcript.length > MAX_TRANSCRIPT_LENGTH) {
            console.warn("[Gemini Live] Oversized transcript rejected.");
          }

          return;
        }

        const meta = {
          hasLeadingSpace: /^\s/.test(rawTranscript),
          turnComplete,
        };

        console.log("[Gemini Live] Transcript chunk:", customerText(transcript));

        Promise.resolve()
          .then(() => onTranscript(transcript, meta))
          .catch((error) => {
            console.error(
              "[Gemini Live] Transcript processing failed:",
              error?.message || error
            );
          });
      },

      onerror: (error) => {
        onEvent({ e: "error", message: String(error?.message || "").slice(0, 200) });
        console.error("[Gemini Live] Connection error:", {
          name: error?.name ?? null,
          message: error?.message ?? null,
          code: error?.code ?? null,
          status: error?.status ?? null,
          details: error?.error?.message ?? null,
        });
      },

      onclose: (event) => {
        onEvent({ e: "close", code: event?.code ?? null, reason: String(event?.reason || "").slice(0, 200) });
        console.error("[Gemini Live] Session closed:", {
          code: event?.code ?? null,
          reason: event?.reason ?? null,
          wasClean: event?.wasClean ?? null,
          eventType: event?.type ?? null,
        });

        try {
          onClose?.(event);
        } catch (error) {
          console.error(
            "[Gemini Live] onClose handler failed:",
            error?.message || error
          );
        }
      },
    },
  });

  return session;
}