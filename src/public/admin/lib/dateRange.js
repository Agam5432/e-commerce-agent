/** @param {string} timezone @param {number} [now] */
export function todayIn(timezone, now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** @param {string} ymd @param {number} delta */
export function addDays(ymd, delta) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/**
 * @param {string} preset
 * @param {string} [timezone]
 * @param {number} [now]
 * @param {import('../types.js').CustomRange} [custom]
 * @returns {import('../types.js').DateRange}
 */
export function rangeFor(preset, timezone = "UTC", now = Date.now(), custom = {}) {
  const today = todayIn(timezone, now);
  switch (preset) {
    case "today": return { from: today, to: today };
    case "yesterday": { const y = addDays(today, -1); return { from: y, to: y }; }
    case "last7": return { from: addDays(today, -6), to: today };
    case "last14": return { from: addDays(today, -13), to: today };
    case "last30": return { from: addDays(today, -29), to: today };
    case "custom": {
      const from = custom.from || today;
      const to = custom.to || from;
      return from <= to ? { from, to } : { from: to, to: from };
    }
    default: throw new Error(`Unknown date preset: ${preset}`);
  }
}

/** Days in a range, counting both ends. @param {{from: string, to: string}} range */
export function daysIn(range) {
  const [fy, fm, fd] = range.from.split("-").map(Number);
  const [ty, tm, td] = range.to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
}

/** The same number of days straight before this range, to say "up 12% on the 14 days before". @param {{from: string, to: string}} range */
export function previousRange(range) {
  const days = daysIn(range);
  return { from: addDays(range.from, -days), to: addDays(range.from, -1) };
}

/** "Up 12%" / "Down 8%" / "" when there is nothing to compare with (no earlier sales, or a different currency). */
/** @param {number} now @param {number} before */
export function changeText(now, before) {
  if (!(before > 0) || !Number.isFinite(now)) return "";
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return "No change";
  // against a tiny earlier number a percentage means nothing ("Up 13117%"): cap it
  const shown = Math.abs(pct) > 999 ? "999%+" : `${Math.abs(pct)}%`;
  return `${pct > 0 ? "Up" : "Down"} ${shown}`;
}
