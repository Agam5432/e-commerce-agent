// Startup configuration check. In production the server refuses to start with a broken
// configuration instead of failing on the first customer's message.

const isSet = (env, name) => String(env[name] ?? "").trim() !== "";

// a tunnel or a private/local address, judged by the host name only (a real domain that merely contains "ngrok" is fine)
function isTunnelOrLocalHost(url) {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  const tunnel = /(^|\.)(ngrok(-free)?\.(dev|app|io)|trycloudflare\.com|loca\.lt)$/;
  const privateV4 = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;
  return tunnel.test(host) || host === "localhost" || host.endsWith(".localhost") || privateV4.test(host) || host === "[::1]";
}

export function validateEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  const production = env.NODE_ENV === "production";

  if (!isSet(env, "MONGODB_URI")) errors.push("MONGODB_URI is required.");
  if (!isSet(env, "SHOPIFY_CLIENT_ID") && !isSet(env, "SHOPIFY_API_KEY")) errors.push("SHOPIFY_CLIENT_ID (or SHOPIFY_API_KEY) is required.");
  if (!isSet(env, "SHOPIFY_CLIENT_SECRET") && !isSet(env, "SHOPIFY_API_SECRET")) errors.push("SHOPIFY_CLIENT_SECRET (or SHOPIFY_API_SECRET) is required.");

  const encKey = env.SHOPIFY_TOKEN_ENCRYPTION_KEY || env.TOKEN_ENCRYPTION_KEY || "";
  if (!encKey) errors.push("SHOPIFY_TOKEN_ENCRYPTION_KEY is required (32-byte base64).");
  else {
    let bytes = 0;
    try {
      bytes = Buffer.from(encKey, "base64").length;
    } catch {
      bytes = 0;
    }
    if (bytes !== 32) errors.push("SHOPIFY_TOKEN_ENCRYPTION_KEY must decode (base64) to exactly 32 bytes.");
  }
  // two names for one key: if both are set they must agree, or tokens would be written with one and read with the other
  if (isSet(env, "SHOPIFY_TOKEN_ENCRYPTION_KEY") && isSet(env, "TOKEN_ENCRYPTION_KEY") && String(env.SHOPIFY_TOKEN_ENCRYPTION_KEY).trim() !== String(env.TOKEN_ENCRYPTION_KEY).trim()) {
    errors.push("SHOPIFY_TOKEN_ENCRYPTION_KEY and TOKEN_ENCRYPTION_KEY are both set but differ: keep one (SHOPIFY_TOKEN_ENCRYPTION_KEY), and put an old key in TOKEN_ENCRYPTION_PREVIOUS_KEYS.");
  }
  String(env.TOKEN_ENCRYPTION_PREVIOUS_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .forEach((k, i) => {
      if (Buffer.from(k, "base64").length !== 32) errors.push(`TOKEN_ENCRYPTION_PREVIOUS_KEYS entry ${i + 1} must decode (base64) to exactly 32 bytes.`);
    });

  const hasGemini = isSet(env, "GEMINI_API_KEY") || isSet(env, "GEMINI_API");
  const hasClaude = isSet(env, "ANTHROPIC_API_KEY");
  if (!hasGemini && !hasClaude) {
    (production ? errors : warnings).push("No AI provider key (GEMINI_API_KEY or ANTHROPIC_API_KEY): replies will run in degraded mode.");
  }
  const secondary = String(env.LLM_SECONDARY || "").toLowerCase();
  if (secondary === "groq" || String(env.LLM_PRIMARY || "").toLowerCase() === "groq") warnings.push("Groq is no longer supported; LLM_PRIMARY/LLM_SECONDARY=groq is ignored (Gemini, then Claude, are used).");
  if (String(env.LLM_PRIMARY || "").toLowerCase() === "claude" && !hasClaude) warnings.push("LLM_PRIMARY=claude but ANTHROPIC_API_KEY is not set.");
  if (secondary === "claude" && !hasClaude) warnings.push("LLM_SECONDARY=claude but ANTHROPIC_API_KEY is not set.");

  if (production) {
    const appUrl = String(env.APP_URL || "");
    if (!/^https:\/\//.test(appUrl)) errors.push("APP_URL must be an https:// URL in production.");
    // OAuth redirects, the app proxy and webhooks are built from APP_URL: a tunnel or local address breaks them
    // for every store as soon as the tunnel stops, so it never belongs in production.
    else if (isTunnelOrLocalHost(appUrl)) {
      errors.push("APP_URL points at a tunnel or a local address (ngrok, trycloudflare, localhost): use the real production domain.");
    }
    // Shopify sends the shop back to the OAuth redirect address after the install: it must be a real address on the same host as APP_URL.
    const redirect = String(env.SHOPIFY_OAUTH_REDIRECT_URI || "").trim();
    if (redirect) {
      let sameHost = false;
      try { sameHost = new URL(redirect).host === new URL(appUrl).host; } catch { /* reported below */ }
      if (isTunnelOrLocalHost(redirect)) errors.push("SHOPIFY_OAUTH_REDIRECT_URI points at a tunnel or a local address: use the real production domain.");
      else if (!sameHost) errors.push("SHOPIFY_OAUTH_REDIRECT_URI must be an address on the same host as APP_URL (Shopify sends the shop back to it after the install).");
    }
    if (!isSet(env, "METRICS_TOKEN")) warnings.push("METRICS_TOKEN not set: /metrics is switched off, so there are no metrics to watch in production.");
    if (!isSet(env, "SENTRY_DSN") && !isSet(env, "ALERT_WEBHOOK_URL")) warnings.push("Neither SENTRY_DSN nor ALERT_WEBHOOK_URL is set: nobody is told when the server errors or crashes.");
  }
  if (!isSet(env, "EMAIL_USER") || !isSet(env, "EMAIL_APP_PASSWORD")) {
    warnings.push("EMAIL_USER / EMAIL_APP_PASSWORD not set: order confirmation emails and order-lookup codes cannot be sent.");
  }
  const scopes = String(env.SHOPIFY_SCOPES || "");
  if (scopes && !scopes.includes("read_legal_policies")) {
    warnings.push("SHOPIFY_SCOPES lacks read_legal_policies: warranty/return questions cannot read the store's published policies.");
  }
  if (isSet(env, "EXPRESS_SHIPPING_COST")) {
    warnings.push("EXPRESS_SHIPPING_COST is no longer used: shipping fees come from the store's Shopify shipping rates.");
  }
  if (String(env.ATTACHMENT_STORAGE || "mongo").toLowerCase() === "s3") {
    const missing = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].filter((name) => !isSet(env, name));
    if (missing.length) errors.push(`ATTACHMENT_STORAGE=s3 needs ${missing.join(", ")}.`);
  } else if (isSet(env, "ATTACHMENT_STORAGE") && String(env.ATTACHMENT_STORAGE).toLowerCase() !== "mongo") {
    errors.push("ATTACHMENT_STORAGE must be mongo or s3.");
  }
  if (isSet(env, "METRICS_TOKEN") && String(env.METRICS_TOKEN).length < 24) errors.push("METRICS_TOKEN must be at least 24 characters.");
  if (isSet(env, "ALERT_WEBHOOK_URL") && !/^https:\/\//.test(String(env.ALERT_WEBHOOK_URL))) errors.push("ALERT_WEBHOOK_URL must be an https:// URL.");
  if (isSet(env, "SENTRY_DSN") && !/^https:\/\/[^@\s]+@[^/\s]+\/\d+$/.test(String(env.SENTRY_DSN))) errors.push("SENTRY_DSN does not look like https://<key>@<host>/<project id>.");
  if (production && !isSet(env, "CLAMAV_HOST")) warnings.push("CLAMAV_HOST not set: shopper files are checked by content but not scanned for viruses.");
  return { ok: errors.length === 0, errors, warnings };
}
/** The one Shopify Admin API version every Shopify call uses (override with SHOPIFY_API_VERSION). */
export const shopifyApiVersion = () => process.env.SHOPIFY_API_VERSION || "2026-10";

/** Prices are shown in the shopper's own Shopify storefront currency (Shopify's contextual prices for their country).
 *  On by default; STORE_PRICES_FOLLOW_MARKET=0 brings back store-currency-only pricing. */
export function pricesFollowMarket(env = process.env) {
  return String(env.STORE_PRICES_FOLLOW_MARKET ?? "").trim() !== "0";
}
