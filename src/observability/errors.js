// Error reporting: every reported error is counted (errors_total) and, with SENTRY_DSN, sent to Sentry
// through its HTTP envelope API (no SDK). Messages and stacks are redacted (no emails or phone numbers)
// and the same error is sent at most once a minute, so a loop cannot flood the project.
import crypto from "node:crypto";
import os from "node:os";
import { redact } from "../utils/logger.js";
import { inc } from "./metrics.js";

/** { url, key } for the envelope endpoint, or null for a missing or malformed DSN. */
export function parseDsn(dsn) {
  const m = String(dsn || "").match(/^(https?):\/\/([^@\s/]+)@([^/\s]+)\/(\d+)$/);
  if (!m) return null;
  return { url: `${m[1]}://${m[3]}/api/${m[4]}/envelope/`, key: m[2], dsn: String(dsn) };
}

export function buildEnvelope(error, { scope = "server", tags = {}, env = process.env, now = Date.now } = {}) {
  const eventId = crypto.randomBytes(16).toString("hex");
  const err = error instanceof Error ? error : new Error(String(error));
  const event = {
    event_id: eventId,
    timestamp: now() / 1000,
    platform: "node",
    level: "error",
    logger: scope,
    environment: String(env.NODE_ENV || "development"),
    ...(env.RELEASE ? { release: String(env.RELEASE) } : {}),
    server_name: os.hostname(),
    tags: Object.fromEntries(Object.entries({ scope, ...tags }).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v).slice(0, 200)])),
    exception: { values: [{ type: err.name || "Error", value: redact(err.message).slice(0, 2000) }] },
    extra: { stack: redact(err.stack || "").slice(0, 8000) },
  };
  const header = { event_id: eventId, sent_at: new Date(now()).toISOString() };
  return { eventId, body: `${JSON.stringify(header)}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}` };
}

export function createErrorReporter({ env = process.env, fetchImpl = (...a) => fetch(...a), now = Date.now, log = console } = {}) {
  const target = parseDsn(env.SENTRY_DSN);
  const recent = new Map();
  return {
    enabled: Boolean(target),
    async report(error, { scope = "server", tags = {} } = {}) {
      inc("errors_total", { scope }, 1, "Errors reported, by part of the app");
      if (!target) return false;
      const fingerprint = `${scope}:${String(error?.message || error).slice(0, 120)}`;
      const t = now();
      if (recent.has(fingerprint) && t - recent.get(fingerprint) < 60_000) return false;
      recent.set(fingerprint, t);
      if (recent.size > 500) for (const [k, at] of recent) if (t - at > 60_000) recent.delete(k);
      const { body } = buildEnvelope(error, { scope, tags, env, now });
      try {
        const res = await fetchImpl(target.url, {
          method: "POST",
          headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${target.key}, sentry_client=orbi-backend/1.0` },
          body,
          signal: AbortSignal.timeout(5000),
        });
        return res.ok;
      } catch (e) {
        log.warn?.(`[errors] could not reach Sentry: ${String(e?.message || e).slice(0, 120)}`);
        return false;
      }
    },
  };
}

let shared;
export function errorReporter() {
  shared ||= createErrorReporter();
  return shared;
}
/** Fire and forget. */
export function reportError(error, context) {
  void errorReporter().report(error, context).catch(() => {});
}
