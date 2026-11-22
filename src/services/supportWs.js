// Who may open the live-support WebSocket (/support-ws), and what they become.
//   shopper:  subprotocol "orbi.token.<token>", a one-time token made by /proxy/support/token for ONE call
//   dashboard: subprotocol "orbi.admin.<token>", the Shopify session token of a signed-in team member
// Both ride next to the real protocol "orbi.support.v1", because a browser cannot set headers on a WebSocket and a
// token in the address ends up in logs. The store is read from the verified token, never from the address.
import { WebSocketServer } from "ws";
import { verifyVoiceSessionToken } from "./voiceTokenService.js";
import { tokenReplayGuard } from "./tokenReplay.js";
import { verifySessionToken } from "../admin/auth.js";
import { verifyConsoleToken } from "../admin/consoleAuth.js";
import { isActiveStore } from "./storeIntegrationService.js";
import { offeredProtocols } from "../voice/voiceAuth.js";

export const SUPPORT_PROTOCOL = "orbi.support.v1";
export const SUPPORT_PATH = "/support-ws";
const CUSTOMER_PREFIX = "orbi.token.";
const ADMIN_PREFIX = "orbi.admin.";
const CONSOLE_PREFIX = "orbi.console.";

/** The verified identity for an upgrade request, or null. A shopper's token is used up. */
export async function authorizeSupportUpgrade(req, { guard = tokenReplayGuard(), verifyAdmin = verifySessionToken, verifyConsole = verifyConsoleToken, active = isActiveStore } = {}) {
  const offered = offeredProtocols(req);
  if (!offered.includes(SUPPORT_PROTOCOL)) return null;
  const adminToken = offered.find((p) => p.startsWith(ADMIN_PREFIX));
  if (adminToken) {
    try {
      const { shop, userId } = verifyAdmin(adminToken.slice(ADMIN_PREFIX.length));
      if (!(await active(shop))) return null;
      return { role: "admin", shop, userId };
    } catch {
      return null;
    }
  }
  const consoleToken = offered.find((p) => p.startsWith(CONSOLE_PREFIX));
  if (consoleToken) {
    const known = verifyConsole(consoleToken.slice(CONSOLE_PREFIX.length));
    if (!known || !(await active(known.shop))) return null;
    return { role: "admin", shop: known.shop, userId: known.userId };
  }
  const customerToken = offered.find((p) => p.startsWith(CUSTOMER_PREFIX));
  if (customerToken) {
    const claims = verifyVoiceSessionToken(customerToken.slice(CUSTOMER_PREFIX.length), { purpose: "support" });
    if (!claims || !claims.ref) return null;
    if (!(await guard.consume(claims.jti, claims.exp))) return null;
    return { role: "customer", shop: claims.shop, callId: claims.ref };
  }
  return null;
}

/**
 * The /support-ws server. Returns { wss, handleUpgrade }: server.js routes upgrade requests for SUPPORT_PATH to
 * handleUpgrade; every other upgrade keeps going to the voice server exactly as before.
 */
export function createSupportServer({ hub, name = (rep) => rep, authorize = authorizeSupportUpgrade, log = console } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, handleProtocols: (protocols) => (protocols.has(SUPPORT_PROTOCOL) ? SUPPORT_PROTOCOL : false) });

  function reject(socket, code, text) {
    try {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } catch { /* already gone */ }
    socket.destroy();
  }

  async function handleUpgrade(req, socket, head) {
    let who;
    try {
      who = await authorize(req);
    } catch (error) {
      log.error?.("[support] upgrade check failed:", error?.message);
      return reject(socket, 500, "Unavailable");
    }
    if (!who) return reject(socket, 401, "Unauthorized");
    wss.handleUpgrade(req, socket, head, (ws) => {
      // a dead connection must not look alive: ping, and drop what does not answer
      ws.isAlive = true;
      ws.on("pong", () => {
        ws.isAlive = true;
        if (who.role === "admin") hub.touchAdmin?.(who.shop, who.userId);
      });
      const attach = who.role === "admin"
        ? hub.attachAdmin(ws, { shop: who.shop, rep: { id: who.userId, name: name(who.userId) } })
        : hub.attachCustomer(ws, { shop: who.shop, callId: who.callId });
      Promise.resolve(attach).catch((error) => {
        log.error?.("[support] attach failed:", error?.message);
        try { ws.close(1011, "Unavailable"); } catch { /* gone */ }
      });
    });
  }

  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* terminated next round */ }
    }
  }, 25_000);
  pinger.unref?.();

  return { wss, handleUpgrade, close: () => { clearInterval(pinger); for (const ws of wss.clients) ws.close(1001, "restart"); wss.close(); } };
}
