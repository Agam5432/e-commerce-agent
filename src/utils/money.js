// One place that formats prices in the STORE's own currency (INR, USD, EUR, GBP, AED, JPY, ...).
const LOCALES = {
  INR: "en-IN", USD: "en-US", GBP: "en-GB", EUR: "en-IE", AED: "en-AE", AUD: "en-AU",
  CAD: "en-CA", SGD: "en-SG", NZD: "en-NZ", JPY: "ja-JP", ZAR: "en-ZA", SAR: "en-SA",
};

/** The sign a currency is written with in its own locale ("$" for USD, "₹" for INR, "€" for EUR); "" when the code is not a currency. */
export function currencyMark(currency) {
  const code = String(currency || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return "";
  try {
    return new Intl.NumberFormat(LOCALES[code] || "en", { style: "currency", currency: code }).formatToParts(0).find((p) => p.type === "currency")?.value || code;
  } catch {
    return "";
  }
}

export function formatMoney(amount, currency) {
  if (amount == null || amount === "") return "";
  const code = String(currency || "").trim().toUpperCase();
  const num = Number(amount);
  if (!Number.isFinite(num)) return `${amount} ${code}`.trim();
  if (!/^[A-Z]{3}$/.test(code)) return num.toFixed(2);
  try {
    // INR is shown without trailing .00 for whole amounts (₹8,999), other currencies use their standard decimals.
    // ...but a fractional amount always has both paise digits (₹56,858.30, never ₹56,858.3: a real order confirmation, 2026-11-21).
    const whole = Math.abs(num - Math.round(num)) < 0.005;
    const options = { style: "currency", currency: code, ...(code === "INR" ? (whole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : {}) };
    return new Intl.NumberFormat(LOCALES[code] || "en", options).format(num);
  } catch {
    return `${num.toFixed(2)} ${code}`;
  }
}