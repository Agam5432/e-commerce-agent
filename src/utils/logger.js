// Small leveled logger. LOG_LEVEL = error | warn | info | debug (default: info in production,
// debug otherwise). LOG_FORMAT=json prints one JSON object per line (for log collectors).
// Customer text is logged only as its length (see customerText), and personal data is masked.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function currentLevel() {
  const raw = String(process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug")).toLowerCase();
  return LEVELS[raw] ?? LEVELS.info;
}

/** Masks emails and phone numbers so logs never carry a shopper's contact details. */
export function redact(value) {
  return String(value ?? "")
    .replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "$1***@$2")
    // a number inside an id or a value (gid://shopify/Order/123…, #1001, at=…, "ms":…) is not a phone number
    .replace(/(?<![/#:=\w.])(\+?\d[\d\s-]{6,}\d)/g, (m) => {
      const digits = m.replace(/\D/g, "");
      return digits.length >= 8 ? `***${digits.slice(-2)}` : m;
    });
}

function emit(level, scope, message, meta) {
  if (LEVELS[level] > currentLevel()) return;
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (String(process.env.LOG_FORMAT || "").toLowerCase() === "json") {
    sink(JSON.stringify({ time: new Date().toISOString(), level, scope, message: String(message), ...(meta ? { meta } : {}) }));
    return;
  }
  const prefix = scope ? `[${scope}]` : "";
  if (meta === undefined) sink(`${prefix} ${message}`.trim());
  else sink(`${prefix} ${message}`.trim(), typeof meta === "string" ? meta : JSON.stringify(meta));
}

/**
 * What a shopper said or typed, as it may appear in a log line. By default only its length is logged:
 * transcripts and messages are personal data. LOG_CUSTOMER_TEXT=1 shows the (redacted, shortened) text
 * for local debugging; it is ignored in production.
 */
export function customerText(value, { env = process.env, max = 160 } = {}) {
  const text = String(value ?? "");
  const allowed = env.LOG_CUSTOMER_TEXT === "1" && env.NODE_ENV !== "production";
  return allowed ? JSON.stringify(redact(text).slice(0, max)) : `<${text.length} chars>`;
}

// Fields whose values are a person's details. Matched on the key name, so a tool call can be traced
// (which tool, which product, which step) without the customer's email, phone, address or codes.
const PERSONAL_KEY = /(?:^|_)(?:e?mail|phone|mobile|whatsapp|address\d*|street|line\d|city|zip|postal|postcode|pincode|landmark|first_?name|last_?name|full_?name|customer_?name|name|otp|code|password|token|secret|card|upi|ip)$|(?:Email|Phone|Mobile|Address|Name|Otp|Code|Token)$/i;

/** A copy of `value` with personal fields masked and any email or phone number inside text redacted. */
export function maskPersonal(value, depth = 0) {
  if (depth > 6) return "[…]";
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => maskPersonal(v, depth + 1));
  if (value && typeof value === "object" && !(value instanceof Error)) {
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = PERSONAL_KEY.test(key) && v != null && v !== "" ? "***" : maskPersonal(v, depth + 1);
    return out;
  }
  return value;
}

/**
 * A safety net for every console call in the process (including libraries): emails and phone numbers
 * in strings are redacted and personal fields of logged objects are masked. Installed once at start-up.
 */
export function installConsoleRedaction(target = console) {
  if (target.__redacting) return target;
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    const original = target[method]?.bind(target);
    if (!original) continue;
    target[method] = (...args) =>
      original(...args.map((arg) => (arg instanceof Error ? Object.assign(new Error(redact(arg.message)), { name: arg.name, stack: redact(arg.stack || "") }) : maskPersonal(arg))));
  }
  Object.defineProperty(target, "__redacting", { value: true });
  return target;
}

export function createLogger(scope = "") {
  return {
    error: (message, meta) => emit("error", scope, message, meta),
    warn: (message, meta) => emit("warn", scope, message, meta),
    info: (message, meta) => emit("info", scope, message, meta),
    debug: (message, meta) => emit("debug", scope, message, meta),
    enabled: (level) => LEVELS[level] <= currentLevel(),
  };
}

export const logger = createLogger("");