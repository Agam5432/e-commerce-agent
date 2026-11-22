// The live side of human support: WebSocket connections of the shoppers who asked for a call and of the store's
// team in the dashboard, and the signalling between them (the audio itself goes browser to browser over WebRTC and
// never passes through this server). All state of record is in MongoDB (supportService.js); this file only keeps
// who is connected on THIS instance and passes messages along.
//
// Messages are JSON: { type, ... }.
//   dashboard -> server: heartbeat, presence {status}, auth {token}, accept {callId}, reject {callId},
//                        signal {callId, kind, data}, connected {callId}, hangup {callId, reason?}, recording {callId, state, error?}
//   shopper   -> server: signal {callId, kind, data}, connected {callId}, hangup {callId, reason?}, withdraw_recording {callId}
//   server -> dashboard: ready, presence, incoming {call}, incoming_gone {callId, reason}, accepted {call},
//                        signal, connected, ended {call}, recording_withdrawn {callId}, error {code, message}
//   server -> shopper:   ready, accepted {call, representative}, signal, connected, ended {call}, recording_withdrawn, error
//
// One instance keeps the sockets; running several needs the same shopper and team member to reach the same one
// (see the README): nothing here is shared between processes except what is in the database.
import * as support from "./supportService.js";

const HEARTBEAT_DB_MS = 15_000;
// a team member's session token lives a minute; the dashboard sends a fresh one every few minutes
const ADMIN_AUTH_VALID_MS = 15 * 60_000;
const CUSTOMER_GRACE_MS = (Number(process.env.SUPPORT_CUSTOMER_GRACE_SECONDS) > 0 ? Number(process.env.SUPPORT_CUSTOMER_GRACE_SECONDS) : 20) * 1000;
const SIGNAL_KINDS = new Set(["offer", "answer", "candidate"]);
const MAX_SIGNAL_CHARS = 20_000;

const send = (ws, payload) => {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  } catch { /* the socket is going away; its close handler cleans up */ }
};

/**
 * @param {object} deps injectable for tests
 */
export function createSupportHub({ service = support, settingsFor, verifyAdmin, now = () => Date.now(), log = console, graceMs = CUSTOMER_GRACE_MS } = {}) {
  /** shop -> Set<{ ws, rep: {id, name}, authUntil, lastBeat }> */
  const admins = new Map();
  /** callId -> { ws, shop, timer } */
  const customers = new Map();

  const adminsOf = (shop) => admins.get(shop) || new Set();
  const repSockets = (shop, repId) => [...adminsOf(shop)].filter((a) => a.rep.id === repId);
  const toAdmins = (shop, payload, only = () => true) => adminsOf(shop).forEach((a) => only(a) && send(a.ws, payload));
  const toRep = (shop, repId, payload) => repSockets(shop, repId).forEach((a) => send(a.ws, payload));
  const toCustomer = (callId, payload) => {
    const c = customers.get(String(callId));
    if (c) send(c.ws, payload);
  };

  async function broadcastPresence(shop) {
    try {
      const team = await service.listPresence(shop);
      toAdmins(shop, { type: "presence", team });
    } catch (error) {
      log.warn?.("[support] presence broadcast failed:", error?.message);
    }
  }

  // ---- shopper side ------------------------------------------------------------------------------------------------
  /** A shopper's socket, already authorised for exactly one call (the token carries it). */
  async function attachCustomer(ws, { shop, callId }) {
    const id = String(callId);
    const call = await service.getCall(shop, id);
    if (!call || call.chatRef == null) {
      send(ws, { type: "error", code: "not_found", message: "This call is no longer available." });
      return ws.close(1008, "unknown call");
    }
    const previous = customers.get(id);
    if (previous) {
      clearTimeout(previous.timer);
      try { previous.ws.close(1000, "replaced"); } catch { /* already closed */ }
    }
    const entry = { ws, shop, timer: null };
    customers.set(id, entry);
    send(ws, { type: "ready", role: "customer", call: service.callView(call), ice: service.iceServers() });
    if (["accepted", "connected"].includes(call.status)) send(ws, { type: "accepted", call: service.callView(call), representative: call.representative || null, resumed: true });
    ws.on("message", (raw) => onCustomerMessage(entry, id, raw));
    ws.on("close", () => {
      if (customers.get(id) !== entry) return;
      // they may be reconnecting (a network blip): give them a moment before treating the call as over
      entry.timer = setTimeout(() => customerGone(entry, id), graceMs);
      entry.timer.unref?.();
    });
  }

  async function customerGone(entry, id) {
    if (customers.get(id) === entry) customers.delete(id);
    try {
      const call = await service.getCall(entry.shop, id);
      if (!call) return;
      if (call.status === "requested") {
        const out = await service.cancelCall(entry.shop, call.chatRef, id);
        if (out) toAdmins(entry.shop, { type: "incoming_gone", callId: id, reason: "cancelled" });
      } else if (["accepted", "connected"].includes(call.status)) {
        const ended = await service.endCall(entry.shop, id, { by: "shopper", failure: call.status === "connected" ? "" : "the shopper left before the audio connected" });
        if (ended) finish(entry.shop, call, ended);
      }
    } catch (error) {
      log.warn?.("[support] customer disconnect handling failed:", error?.message);
    }
  }

  async function onCustomerMessage(entry, id, raw) {
    const msg = parse(raw);
    if (!msg) return;
    try {
      if (msg.type === "signal") return relaySignal({ from: "customer", shop: entry.shop, callId: id, msg });
      if (msg.type === "connected") return connected(entry.shop, id);
      if (msg.type === "hangup") return hangup(entry.shop, id, "shopper", msg.reason);
      if (msg.type === "withdraw_recording") {
        const call = await service.getCall(entry.shop, id);
        if (!call) return;
        const out = await service.withdrawRecording(entry.shop, call.chatRef, id);
        if (out && call.representative?.id) toRep(entry.shop, call.representative.id, { type: "recording_withdrawn", callId: id });
        toCustomer(id, { type: "recording_withdrawn", callId: id });
      }
    } catch (error) {
      log.warn?.("[support] shopper message failed:", error?.message);
      send(entry.ws, { type: "error", code: "failed", message: "Something went wrong." });
    }
  }

  // ---- team side -------------------------------------------------------------------------------------------------
  /** A team member's dashboard connected. `rep` comes from the verified Shopify session token. */
  async function attachAdmin(ws, { shop, rep }) {
    const entry = { ws, rep, authUntil: now() + ADMIN_AUTH_VALID_MS, lastBeat: 0 };
    if (!admins.has(shop)) admins.set(shop, new Set());
    admins.get(shop).add(entry);
    const [team, waiting, active] = await Promise.all([service.listPresence(shop), service.waitingFor(shop, rep.id), activeFor(shop, rep.id)]);
    send(ws, { type: "ready", role: "admin", representative: rep, team, waiting, active, ice: service.iceServers(), turn: service.turnConfigured() });
    ws.on("message", (raw) => onAdminMessage(shop, entry, raw));
    ws.on("close", () => adminGone(shop, entry));
  }

  async function activeFor(shop, repId) {
    const rows = await service.listCalls(shop, { limit: 5 });
    return rows.find((c) => ["accepted", "connected"].includes(c.status) && c.representative?.id === repId) || null;
  }

  async function adminGone(shop, entry) {
    const set = admins.get(shop);
    set?.delete(entry);
    if (set && !set.size) admins.delete(shop);
    // another tab of the same person keeps them present; otherwise they can no longer take calls
    if (repSockets(shop, entry.rep.id).length) return;
    try {
      await service.dropPresence(shop, entry.rep.id);
      await broadcastPresence(shop);
    } catch (error) {
      log.warn?.("[support] could not drop presence:", error?.message);
    }
  }

  async function onAdminMessage(shop, entry, raw) {
    const msg = parse(raw);
    if (!msg) return;
    if (msg.type !== "auth" && now() > entry.authUntil) {
      send(entry.ws, { type: "error", code: "auth_expired", message: "Sign in again." });
      return entry.ws.close(4401, "auth expired");
    }
    try {
      switch (msg.type) {
        case "auth": {
          const who = await verifyAdmin?.(msg.token);
          if (!who || who.shop !== shop || who.userId !== entry.rep.id) return entry.ws.close(4401, "bad token");
          entry.authUntil = now() + ADMIN_AUTH_VALID_MS;
          return;
        }
        case "heartbeat":
        case "presence": {
          if (msg.type === "heartbeat" && now() - entry.lastBeat < HEARTBEAT_DB_MS) return;
          entry.lastBeat = now();
          if (typeof msg.name === "string" && msg.name.trim()) entry.rep.name = msg.name.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 80);
          const status = msg.type === "presence" ? msg.status : undefined;
          await service.setPresence(shop, { representativeId: entry.rep.id, name: entry.rep.name, status });
          if (msg.type === "presence") await broadcastPresence(shop);
          return;
        }
        case "accept": return await accept(shop, entry, msg.callId);
        case "reject": return await reject(shop, entry, msg.callId);
        case "signal": return relaySignal({ from: "admin", shop, callId: String(msg.callId || ""), msg, repId: entry.rep.id });
        case "connected": return await connected(shop, String(msg.callId || ""));
        case "hangup": return await hangup(shop, String(msg.callId || ""), "team", msg.reason);
        case "recording": {
          if (msg.state === "failed") await service.recordingFailed(shop, String(msg.callId || ""), msg.error);
          return;
        }
        default:
      }
    } catch (error) {
      const status = error?.status && error.status < 500 ? error : null;
      if (!status) log.warn?.("[support] team message failed:", error?.message);
      send(entry.ws, { type: "error", code: status?.code || "failed", message: status ? error.message : "Something went wrong.", callId: msg.callId });
    }
  }

  async function accept(shop, entry, callId) {
    const call = await service.acceptCall(shop, String(callId || ""), { representativeId: entry.rep.id, name: entry.rep.name });
    send(entry.ws, { type: "accepted", call, ice: service.iceServers() });
    // everyone else's incoming card closes; the shopper is told to start the audio
    toAdmins(shop, { type: "incoming_gone", callId: call.id, reason: "taken", by: entry.rep.name }, (a) => a !== entry);
    toCustomer(call.id, { type: "accepted", call, representative: call.representative });
    await broadcastPresence(shop);
  }

  async function reject(shop, entry, callId) {
    const out = await service.rejectCall(shop, String(callId || ""), entry.rep.id);
    send(entry.ws, { type: "incoming_gone", callId, reason: "passed" });
    if (out.closed && out.call) toCustomer(out.call.id, { type: "ended", call: out.call, reason: "unanswered" });
  }

  async function connected(shop, callId) {
    const call = await service.markConnected(shop, callId);
    if (!call) return;
    toCustomer(callId, { type: "connected", call });
    if (call.representative?.id) toRep(shop, call.representative.id, { type: "connected", call });
    await broadcastPresence(shop);
  }

  function relaySignal({ from, shop, callId, msg, repId }) {
    if (!SIGNAL_KINDS.has(msg.kind) || JSON.stringify(msg.data ?? null).length > MAX_SIGNAL_CHARS) return;
    // only the two sides of THIS call, and only while it is open
    service.getCall(shop, callId).then((call) => {
      if (!call || !["accepted", "connected"].includes(call.status)) return;
      const payload = { type: "signal", callId, kind: msg.kind, data: msg.data };
      if (from === "admin") {
        if (call.representative?.id !== repId) return;
        toCustomer(callId, payload);
      } else {
        toRep(shop, call.representative?.id, payload);
      }
    }).catch((error) => log.warn?.("[support] signal failed:", error?.message));
  }

  async function hangup(shop, callId, by, reason) {
    const before = await service.getCall(shop, callId);
    if (!before) return;
    if (before.status === "requested" && by === "shopper") {
      const out = await service.cancelCall(shop, before.chatRef, callId);
      if (out) toAdmins(shop, { type: "incoming_gone", callId, reason: "cancelled" });
      return;
    }
    const ended = await service.endCall(shop, callId, { by, failure: /^audio (failed|timeout)/.test(String(reason || "")) ? String(reason).slice(0, 200) : String(reason || "").slice(0, 100) === "failed" ? "the audio connection failed" : "" });
    if (ended) finish(shop, before, ended);
  }

  /** A call is over: tell both sides and refresh the team. */
  function finish(shop, before, ended) {
    toCustomer(ended.id, { type: "ended", call: ended });
    if (before.representative?.id) toRep(shop, before.representative.id, { type: "ended", call: ended });
    broadcastPresence(shop);
  }

  // ---- called by the HTTP routes and the sweeper --------------------------------------------------------------
  /** A shopper asked for a person: ring everyone who could take it. */
  function announceRequest(shop, call) {
    toAdmins(shop, { type: "incoming", call });
  }
  function announceCancelled(shop, callId) {
    toAdmins(shop, { type: "incoming_gone", callId, reason: "cancelled" });
  }
  /** Calls the sweeper closed: whoever is connected hears about it. */
  function announceClosed(items) {
    for (const { shop, call } of items) {
      toCustomer(call.id, { type: "ended", call, reason: call.status });
      if (call.representative?.id) toRep(shop, call.representative.id, { type: "ended", call });
      toAdmins(shop, { type: "incoming_gone", callId: call.id, reason: call.status });
      broadcastPresence(shop);
    }
  }
  const connectedAdmins = (shop) => adminsOf(shop).size;
  // A browser tab that is hidden or minimised runs its timers slowly, so its own heartbeat can come late. The server pings every
  // open socket and the browser answers on its own, which proves the person is still there: that also counts as a heartbeat.
  const touched = new Map();
  async function touchAdmin(shop, repId) {
    const key = `${shop}|${repId}`;
    if (now() - (touched.get(key) || 0) < HEARTBEAT_DB_MS) return;
    touched.set(key, now());
    if (!repSockets(shop, repId).length) return;
    try {
      await service.setPresence(shop, { representativeId: repId });
    } catch (error) {
      log.warn?.("[support] could not refresh presence:", error?.message);
    }
  }
  const shutdown = () => {
    for (const set of admins.values()) set.forEach((a) => { try { a.ws.close(1001, "restart"); } catch { /* gone */ } });
    for (const c of customers.values()) { clearTimeout(c.timer); try { c.ws.close(1001, "restart"); } catch { /* gone */ } }
    admins.clear();
    customers.clear();
  };

  return { attachCustomer, attachAdmin, touchAdmin, announceRequest, announceCancelled, announceClosed, connectedAdmins, broadcastPresence, shutdown, _debug: { admins, customers } };
}

function parse(raw) {
  try {
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    if (text.length > 64 * 1024) return null;
    const msg = JSON.parse(text);
    return msg && typeof msg === "object" && typeof msg.type === "string" ? msg : null;
  } catch {
    return null;
  }
}
