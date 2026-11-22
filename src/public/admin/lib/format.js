// Display helpers. Money is always shown in the store's own currency.
/** @param {unknown} amount @param {string} [currency] @param {string} [locale] */
export function formatMoney(amount, currency, locale) {
  const value = Number(amount) || 0;
  // Rupee amounts are written 1,84,250 in India, whatever the browser's language is set to
  if (!locale && currency === "INR") locale = "en-IN";
  if (!currency) return value.toLocaleString(locale);
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: value % 1 === 0 ? 0 : 2 }).format(value);
  } catch {
    return `${value.toLocaleString(locale)} ${currency}`;
  }
}

/** @param {unknown} value @param {string} [locale] */
export function formatNumber(value, locale) {
  return (Number(value) || 0).toLocaleString(locale);
}

/** "5:20 am" today, "Yesterday", otherwise a short date, all in the store's time zone. */
/** @param {string | number | undefined} iso @param {string} [timezone] @param {number} [now] @param {string} [locale] */
export function formatWhen(iso, timezone = "UTC", now = Date.now(), locale) {
  const date = new Date(iso ?? NaN);
  if (Number.isNaN(date.getTime())) return "";
  /** @param {Date | number} ms */
  const day = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(ms);
  const time = new Intl.DateTimeFormat(locale, { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(date);
  if (day(date) === day(now)) return `Today, ${time}`;
  if (day(date) === day(now - 86_400_000)) return `Yesterday, ${time}`;
  return `${new Intl.DateTimeFormat(locale, { timeZone: timezone, day: "numeric", month: "short" }).format(date)}, ${time}`;
}

/** "12 Sep" (with the year when it is not this year), for things that only need the day. */
/** @param {string | number | undefined} iso @param {string} [timezone] @param {number} [now] @param {string} [locale] */
export function formatDate(iso, timezone = "UTC", now = Date.now(), locale = "en-GB") {
  const date = new Date(iso ?? NaN);
  if (Number.isNaN(date.getTime())) return "";
  const year = (/** @type {Date | number} */ d) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric" }).format(d);
  return new Intl.DateTimeFormat(locale, { timeZone: timezone, day: "numeric", month: "short", ...(year(date) === year(now) ? {} : { year: "numeric" }) }).format(date);
}

/** For lists of chats and people: "Just now", "12 min ago", "2 hours ago", "Yesterday, 6:10 PM", "3 days ago", then a date. */
/** @param {string | number | undefined} iso @param {string} [timezone] @param {number} [now] @param {string} [locale] */
export function formatAgo(iso, timezone = "UTC", now = Date.now(), locale) {
  const then = new Date(iso ?? NaN).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 0) return formatWhen(iso, timezone, now, locale);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 6) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const day = (/** @type {number} */ ms) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(ms);
  const calendarDays = Math.round((Date.parse(day(now)) - Date.parse(day(then))) / 86_400_000);
  if (calendarDays >= 2 && calendarDays < 7) return `${calendarDays} days ago`;
  return formatWhen(iso, timezone, now, locale);
}

/** "Oct 29" from "2026-10-29" (a calendar day, so no time zone shift). */
/** @param {string} ymd @param {string} [locale] */
export function formatShortDay(ymd, locale = 'en-US') {
  const [y, m, d] = String(ymd).split('-').map(Number);
  if (!y || !m || !d) return String(ymd || '');
  return new Intl.DateTimeFormat(locale, {timeZone: 'UTC', month: 'short', day: 'numeric'}).format(Date.UTC(y, m - 1, d));
}

/** "10:02 AM" in the store's time zone. */
/** @param {string | number | undefined} iso @param {string} [timezone] @param {string} [locale] */
export function formatClock(iso, timezone = "UTC", locale) {
  const date = new Date(iso ?? NaN);
  if (Number.isNaN(date.getTime())) return "";
  // some system locales write "am"/"pm" in lower case: the clock always reads "10:02 AM"
  return new Intl.DateTimeFormat(locale, { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(date).replace(/\b(am|pm)\b/i, (m) => m.toUpperCase());
}

/** "Today", "Yesterday", or "Mon, 2 Nov", for the line that starts each day in a chat. */
/** @param {string | number | undefined} iso @param {string} [timezone] @param {number} [now] @param {string} [locale] */
export function dayLabel(iso, timezone = "UTC", now = Date.now(), locale = "en-GB") {
  const date = new Date(iso ?? NaN);
  if (Number.isNaN(date.getTime())) return "";
  /** @param {Date | number} ms */
  const day = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(ms);
  if (day(date) === day(now)) return "Today";
  if (day(date) === day(now - 86_400_000)) return "Yesterday";
  return new Intl.DateTimeFormat(locale, { timeZone: timezone, weekday: "short", day: "numeric", month: "short" }).format(date);
}

/** The calendar day of a moment in the store's time zone (YYYY-MM-DD), to tell when a chat moves to a new day. */
/** @param {string | number | undefined} iso @param {string} [timezone] */
export function dayKey(iso, timezone = "UTC") {
  const date = new Date(iso ?? NaN);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
}
