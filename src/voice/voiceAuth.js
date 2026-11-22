// Who may open a voice WebSocket. The browser sends the short-lived token as a WebSocket subprotocol
// ("orbi.token.<token>") next to the real protocol ("orbi.voice.v1"), because a browser cannot set headers
// on a WebSocket and a token in the URL ends up in proxy and access logs. The token must be a voice
// token and is accepted once.
// VOICE_TOKEN_IN_URL=1 also accepts the old "?token=" form, only for the few minutes while browsers
// still run the previous widget after a deploy.
import { verifyVoiceSessionToken } from "../services/voiceTokenService.js";
import { tokenReplayGuard } from "../services/tokenReplay.js";

export const VOICE_PROTOCOL = "orbi.voice.v1";
export const TOKEN_PROTOCOL_PREFIX = "orbi.token.";

/** The subprotocols the browser offered, from the upgrade request. */
export function offeredProtocols(req) {
  return String(req?.headers?.["sec-websocket-protocol"] || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

export function tokenFromUpgrade(req, { allowUrlToken = process.env.VOICE_TOKEN_IN_URL === "1" } = {}) {
  const offered = offeredProtocols(req);
  const fromProtocol = offered.find((p) => p.startsWith(TOKEN_PROTOCOL_PREFIX));
  if (fromProtocol && offered.includes(VOICE_PROTOCOL)) return { token: fromProtocol.slice(TOKEN_PROTOCOL_PREFIX.length), via: "protocol" };
  if (allowUrlToken) {
    try {
      const token = new URL(req?.url || "/", "http://localhost").searchParams.get("token");
      if (token) return { token, via: "url" };
    } catch {
      /* no token */
    }
  }
  return null;
}

/** The verified claims for this upgrade request, or null. Uses the token up. */
export async function authorizeVoiceUpgrade(req, { guard = tokenReplayGuard(), allowUrlToken } = {}) {
  const found = tokenFromUpgrade(req, { allowUrlToken });
  if (!found) return null;
  const claims = verifyVoiceSessionToken(found.token, { purpose: "voice" });
  if (!claims) return null;
  if (!(await guard.consume(claims.jti, claims.exp))) return null;
  return { ...claims, via: found.via };
}

/** The protocol the server agrees to: only ours, never the token. */
export function chooseProtocol(protocols) {
  return protocols?.has?.(VOICE_PROTOCOL) ? VOICE_PROTOCOL : false;
}

/**
 * Options for the WebSocketServer: the token is checked (and used up) during the handshake, and a
 * voice slot is taken then too (`admit`, counted across instances), so the connection handler only
 * reads `req.voiceClaims` and `req.voiceSlot`. A slot whose connection never opens is given back.
 */
export function voiceUpgradeOptions({ guard, allowUrlToken, admit = null, log = console, claimWithinMs = 10_000 } = {}) {
  return {
    handleProtocols: chooseProtocol,
    verifyClient: (info, done) => {
      authorizeVoiceUpgrade(info.req, { guard, allowUrlToken })
        .then(async (claims) => {
          if (!claims) {
            log.log?.("WebSocket connection rejected: missing, used or invalid voice token");
            return done(false, 401, "Unauthorized");
          }
          info.req.voiceClaims = claims;
          if (admit) {
            const slot = await admit(claims.shop);
            info.req.voiceSlot = slot;
            if (slot?.ok) {
              const unclaimed = setTimeout(() => {
                if (!info.req.voiceSlotClaimed) slot.release();
              }, claimWithinMs);
              unclaimed.unref?.();
            }
          }
          return done(true);
        })
        .catch((error) => {
          log.error?.("Voice token check failed:", error?.message || error);
          done(false, 500, "Unavailable");
        });
    },
  };
}
