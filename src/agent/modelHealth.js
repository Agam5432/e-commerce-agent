// Share model cooldowns across turns so an outage does not delay every reply.
import { retryAfterMs } from "./core/retry.js";
export function createModelHealth(now = Date.now) {
  const failures = new Map();
  const key = (provider, model) => `${provider}:${model}`;
  return {
    available(provider, model) { return (failures.get(key(provider, model))?.until || 0) <= now(); },
    success(provider, model) { failures.delete(key(provider, model)); },
    /** ms until this model may be tried again (0 = now). */
    retryInMs(provider, model) { return Math.max(0, (failures.get(key(provider, model))?.until || 0) - now()); },
    /** ms until the provider's own "retry after" is over (a short default when it gave none): the real wait for a rate limit. */
    rateLimitReopensInMs(provider, model) { const e = failures.get(key(provider, model)); return e?.rateLimited ? Math.max(0, e.hintUntil - now()) : 0; },
    /** True when the model is paused only because of a rate limit (429): waiting a little brings it back. */
    rateLimited(provider, model) { return Boolean(failures.get(key(provider, model))?.rateLimited) && (failures.get(key(provider, model))?.until || 0) > now(); },
    /** The wait for a rate limit is over: let the models that were paused only for it be tried again. */
    clearRateLimits(provider, models = []) { for (const m of models) if (failures.get(key(provider, m))?.rateLimited) failures.delete(key(provider, m)); },
    /** True when the model is paused after a quick "busy" answer (5xx / overloaded): one more try costs little, so a turn with
     *  nothing else to ask may probe it instead of telling the shopper there is a connection problem. Never true for a
     *  retired model, a rejected key, a rate limit or a timeout (a probe there is wasted or slow). */
    /** True when the model is paused only after a slow or failed answer (a timeout, a 5xx): not retired, not a bad key, not a rate
     *  limit. Such a model may still be asked as a backup when it is the only other model left. */
    softPaused(provider, model) { const e = failures.get(key(provider, model)); return Boolean(e) && e.until > now() && !e.rateLimited && !e.hard; },
    busyOnly(provider, model) { const e = failures.get(key(provider, model)); return Boolean(e?.busy) && e.until > now(); },
    fail(provider, model, error) {
      const text = String(error?.message || error);
      const status = Number(error?.status || error?.code || text.match(/\b(400|401|403|404|429|5\d\d)\b/)?.[1]);
      const previous = failures.get(key(provider, model));
      const count = (previous?.count || 0) + 1;
      const retryAfter = retryAfterMs(error) / 1000;
      const delay = status === 404 || /no longer available|decommissioned|model.*not found/i.test(text) ? 3600000
        : status === 401 || status === 403 ? 300000
        // A rate limit is a "slow down", not an outage: pause for what the server asked (at least 5 s, 15 s when it said nothing)
        : status === 429 ? Math.max(5000, Math.min((retryAfter || 15) * 1000, 3600000))
        : Math.min(30000 * 2 ** Math.min(count - 1, 4), 300000);
      const busy = (status >= 500 && status <= 599) || /overloaded|high demand|unavailable/i.test(text);
      failures.set(key(provider, model), { count, until: now() + delay, rateLimited: status === 429, hard: delay >= 300000 && (status === 404 || status === 401 || status === 403 || delay >= 3600000), busy: busy && delay < 3600000, hintUntil: now() + (retryAfter > 0 ? retryAfter * 1000 : 4000) });
      return delay;
    },
  };
}
