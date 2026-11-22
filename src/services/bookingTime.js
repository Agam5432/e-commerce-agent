// Time-zone arithmetic for call booking, with only the built-in Intl (no date library).
// A store's opening hours are wall-clock times in the store's time zone; bookings are stored as UTC instants.
const formatters = new Map();

function formatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone || timeZone.length > 64) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock parts of an instant in a time zone. weekday: 0 = Sunday. */
export function zonedParts(instant, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour % 24, minute: +parts.minute, second: +parts.second, weekday: WEEKDAYS[parts.weekday] };
}

/** How far the zone is ahead of UTC at this instant, in minutes. */
export function offsetMinutes(instant, timeZone) {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(new Date(instant).getTime() / 1000) * 1000) / 60000);
}

/** The instant (ms since epoch) when the wall clock in `timeZone` reads this date and time. */
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let utc = guess - offsetMinutes(guess, timeZone) * 60000;
  // the offset can differ at the corrected instant (around a daylight-saving change): settle once more
  utc = guess - offsetMinutes(utc, timeZone) * 60000;
  return utc;
}

export const parseClock = (value) => {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? "").trim());
  return m ? +m[1] * 60 + +m[2] : null;
};

export const formatClock = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** The calendar day after (year, month, day), as plain numbers. */
export function addDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** A readable local time for facts handed to the AI and to emails, e.g. "Tue, 4 Nov, 4:30 pm". */
export function describeLocal(instant, timeZone, locale = "en-IN") {
  return new Intl.DateTimeFormat(locale, { timeZone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(instant));
}

/** Local calendar date, e.g. "2026-11-04". */
export function localDate(instant, timeZone) {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
