// Alerts to a chat channel when something needs the operator: every AI provider failing, a store
// hitting its AI ceiling, the database dropping, the virus scanner down, a crash.
// ALERT_WEBHOOK_URL: a Slack or Discord incoming-webhook URL (the message is sent as both `text` and
// `content`, which covers both). The same alert is sent at most once per ALERT_MIN_INTERVAL_MINUTES (default 15).
import { redact } from "../utils/logger.js";
import { inc } from "./metrics.js";

export function createAlerter({ env = process.env, fetchImpl = (...a) => fetch(...a), now = Date.now, log = console } = {}) {
  const url = String(env.ALERT_WEBHOOK_URL || "").trim();
  const intervalMs = (Number(env.ALERT_MIN_INTERVAL_MINUTES) > 0 ? Number(env.ALERT_MIN_INTERVAL_MINUTES) : 15) * 60_000;
  const where = String(env.ALERT_ENVIRONMENT || env.NODE_ENV || "development");
  const lastSent = new Map();
  return {
    enabled: Boolean(url),
    /** `key` groups repeats of the same problem; returns true when a message was sent. */
    async send(key, message) {
      inc("alerts_total", { alert: key }, 1, "Alerts raised, by kind");
      if (!url) return false;
      const t = now();
      if (lastSent.has(key) && t - lastSent.get(key) < intervalMs) return false;
      lastSent.set(key, t);
      const text = `[orbi ${where}] ${redact(String(message)).slice(0, 1500)}`;
      try {
        const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(5000) });
        if (!res.ok) log.warn?.(`[alerts] webhook answered ${res.status}`);
        return res.ok;
      } catch (error) {
        log.warn?.(`[alerts] could not send: ${String(error?.message || error).slice(0, 120)}`);
        return false;
      }
    },
  };
}

let shared;
export function alerter() {
  shared ||= createAlerter();
  return shared;
}
/** Fire and forget: an alert never slows or breaks the request that raised it. */
export function alert(key, message) {
  void alerter().send(key, message).catch(() => {});
}
