// Waiting out a provider's rate limit (HTTP 429) instead of showing the shopper an error.
// A rate limit is "slow down", not an outage: the provider says how long to wait, and a short wait then a retry
// answers the shopper. Nothing here is provider- or store-specific.

/** How long the provider asked us to wait, in ms (0 when it did not say). Reads the retry-after header and Gemini/Claude error text. */
export function retryAfterMs(error) {
  if (!error) return 0;
  const header = error?.headers?.get?.("retry-after") ?? error?.headers?.["retry-after"] ?? error?.response?.headers?.["retry-after"];
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  const text = String(error?.message || error);
  // Gemini: "retryDelay":"23s" or "Please retry in 23.5s"; some SDKs: "retry after 12 seconds"
  const m =
    text.match(/retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)\s*(ms|s)\b/i) ||
    text.match(/retry(?:ing)?\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b/i);
  if (!m) return 0;
  const value = Number(m[1]);
  return Math.round(/^ms|^milli/i.test(m[2]) ? value : value * 1000);
}

/** True for a rate-limit / quota error. */
export function isRateLimitError(error) {
  const status = Number(error?.status || error?.code);
  if (status === 429) return true;
  return /\b429\b|rate[\s_-]*limit|resource[\s_-]*exhausted|quota|too many requests/i.test(String(error?.message || error || ""));
}

/** setTimeout that ends early (rejecting like a cancelled run) when the turn is aborted. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error("Run cancelled");
      err.name = "AbortError";
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error("Run cancelled");
      err.name = "AbortError";
      reject(err);
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * Optional client-side pacing: at most `maxPerMinute` calls per rolling minute, so a burst never reaches the provider's
 * limit at all. 0 (default) switches it off.
 */
export function createPacer({ maxPerMinute = 0, now = Date.now } = {}) {
  const stamps = [];
  return {
    /** ms to wait before another call may start (0 = go now). Records the call when it returns 0. */
    claim() {
      if (!(maxPerMinute > 0)) return 0;
      const t = now();
      while (stamps.length && t - stamps[0] >= 60000) stamps.shift();
      if (stamps.length < maxPerMinute) {
        stamps.push(t);
        return 0;
      }
      return Math.max(1, 60000 - (t - stamps[0]));
    },
  };
}

/**
 * Decides how long to wait before trying again after a rate limit. Returns 0 when waiting is not worth it
 * (the wait would exceed what is left of the budget). `spentMs` is what earlier waits of this call already used.
 */
export function rateLimitWait({ error, fallbackMs = 4000, spentMs = 0, maxTotalMs = 12000 } = {}) {
  const wanted = retryAfterMs(error) || fallbackMs;
  const room = maxTotalMs - spentMs;
  if (room <= 0) return 0;
  // A provider asking for longer than we can spare is not waited for: the caller fails over or reports honestly.
  if (wanted > room) return 0;
  return wanted;
}
