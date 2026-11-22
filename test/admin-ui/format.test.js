import { describe, it, expect } from './harness.js';
import { dayKey, dayLabel, formatAgo, formatDate, formatClock, formatMoney, formatNumber, formatWhen } from "../../src/public/admin/lib/format.js";

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

describe("format", () => {
  it("shows money in the store currency", () => {
    expect(formatMoney(41820, "USD", "en-US")).toBe("$41,820");
    expect(formatMoney(12.5, "USD", "en-US")).toBe("$12.50");
    expect(formatMoney(5, "", "en-US")).toBe("5");
    expect(formatMoney(5, "NOPE", "en-US")).toBe("5 NOPE");
  });
  it("treats bad numbers as zero", () => {
    expect(formatNumber(undefined, "en-US")).toBe("0");
    expect(formatNumber(1234, "en-US")).toBe("1,234");
  });
  it("says Today and Yesterday in the store's time zone", () => {
    expect(formatWhen("2026-10-30T09:00:00Z", "UTC", NOW, "en-US")).toMatch(/^Today, 9:00/);
    expect(formatWhen("2026-10-29T09:00:00Z", "UTC", NOW, "en-US")).toMatch(/^Yesterday/);
    expect(formatWhen("2026-10-01T09:00:00Z", "UTC", NOW, "en-US")).toMatch(/^Oct 1, /);
    expect(formatWhen("garbage", "UTC", NOW)).toBe("");
  });
});

import {formatShortDay} from '../../src/public/admin/lib/format.js';
describe('short day', () => {
  it('shows a calendar day like the design', () => {
    expect(formatShortDay('2026-10-29')).toBe('Oct 29');
    expect(formatShortDay('2026-01-01')).toBe('Jan 1');
    expect(formatShortDay('bad')).toBe('bad');
  });
});

describe("chat day lines", () => {
  it("shows the time on its own, in the store's time zone", () => {
    expect(formatClock("2026-10-30T04:32:00Z", "Asia/Kolkata")).toBe("10:02 AM");
    expect(formatClock("nope")).toBe("");
  });
  it("names today and yesterday, otherwise the date", () => {
    expect(dayLabel("2026-10-30T09:00:00Z", "UTC", NOW)).toBe("Today");
    expect(dayLabel("2026-10-29T09:00:00Z", "UTC", NOW)).toBe("Yesterday");
    expect(dayLabel("2026-10-20T09:00:00Z", "UTC", NOW)).toBe("Tue 20 Oct");
    expect(dayLabel("nope")).toBe("");
  });
  it("tells when a chat moves to a new day in the store's own time zone", () => {
    expect(dayKey("2026-10-30T20:00:00Z", "Asia/Kolkata")).toBe("2026-10-31");
    expect(dayKey("2026-10-30T20:00:00Z", "UTC")).toBe("2026-10-30");
  });
});

describe("formatMoney for rupees", () => {
  it("groups the way India writes it unless a locale is asked for", () => {
    expect(formatMoney(184250, "INR")).toBe("₹1,84,250");
    expect(formatMoney(184250, "INR", "en-US")).toBe("₹184,250");
    expect(formatMoney(1234.5, "USD", "en-US")).toBe("$1,234.50");
  });
});

describe("formatAgo", () => {
  const at = (ms) => new Date(NOW - ms).toISOString();
  const MIN = 60_000, HOUR = 3_600_000;
  it("counts minutes, then hours, for what just happened", () => {
    expect(formatAgo(at(20_000), "UTC", NOW)).toBe("Just now");
    expect(formatAgo(at(12 * MIN), "UTC", NOW)).toBe("12 min ago");
    expect(formatAgo(at(HOUR + MIN), "UTC", NOW)).toBe("1 hour ago");
    expect(formatAgo(at(3 * HOUR), "UTC", NOW)).toBe("3 hours ago");
  });
  it("then says the day, then how many days, then the date", () => {
    expect(formatAgo("2026-10-29T09:00:00Z", "UTC", NOW, "en-US")).toMatch(/^Yesterday, /);
    expect(formatAgo("2026-10-28T09:00:00Z", "UTC", NOW, "en-US")).toBe("2 days ago");
    expect(formatAgo("2026-10-24T09:00:00Z", "UTC", NOW, "en-US")).toBe("6 days ago");
    expect(formatAgo("2026-10-01T09:00:00Z", "UTC", NOW, "en-US")).toMatch(/^Oct 1, /);
  });
  it("copes with a clock that is slightly behind and with garbage", () => {
    expect(formatAgo(at(-5 * MIN), "UTC", NOW, "en-US")).toMatch(/^Today, /);
    expect(formatAgo("garbage", "UTC", NOW)).toBe("");
    expect(formatAgo(undefined, "UTC", NOW)).toBe("");
  });
});

describe("formatDate", () => {
  it("gives the day and month, and the year only when it is another year", () => {
    expect(formatDate("2026-09-12T09:00:00Z", "UTC", NOW)).toMatch(/^12 Sep/);
    expect(formatDate("2025-09-12T09:00:00Z", "UTC", NOW)).toMatch(/12 Sept? 2025/);
    expect(formatDate("garbage", "UTC", NOW)).toBe("");
  });
});
