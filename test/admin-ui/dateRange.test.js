import { describe, it, expect } from './harness.js';
import { addDays, changeText, daysIn, previousRange, rangeFor, todayIn } from "../../src/public/admin/lib/dateRange.js";

// 2026-10-30 20:00 UTC is already 31 Oct in Kolkata (UTC+5:30) and still 30 Oct in New York.
const NOW = Date.UTC(2026, 9, 30, 20, 0, 0);

describe("date ranges", () => {
  it("uses the store's calendar day, not the browser's", () => {
    expect(todayIn("Asia/Kolkata", NOW)).toBe("2026-10-31");
    expect(todayIn("America/New_York", NOW)).toBe("2026-10-30");
  });
  it("builds the presets", () => {
    expect(rangeFor("today", "UTC", NOW)).toEqual({ from: "2026-10-30", to: "2026-10-30" });
    expect(rangeFor("yesterday", "UTC", NOW)).toEqual({ from: "2026-10-29", to: "2026-10-29" });
    expect(rangeFor("last7", "UTC", NOW)).toEqual({ from: "2026-10-24", to: "2026-10-30" });
    expect(rangeFor("last30", "UTC", NOW)).toEqual({ from: "2026-10-01", to: "2026-10-30" });
  });
  it("accepts a custom range in either order and a single day", () => {
    expect(rangeFor("custom", "UTC", NOW, { from: "2026-10-05", to: "2026-10-02" })).toEqual({ from: "2026-10-02", to: "2026-10-05" });
    expect(rangeFor("custom", "UTC", NOW, { from: "2026-10-05" })).toEqual({ from: "2026-10-05", to: "2026-10-05" });
  });
  it("crosses month and year ends", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("rejects an unknown preset", () => {
    expect(() => rangeFor("last year")).toThrow(/Unknown/);
  });
});

describe("14 days and 'the days before'", () => {
  const NOW = Date.parse("2026-11-03T10:00:00Z");
  it("last 14 days ends today and covers 14 calendar days", () => {
    expect(rangeFor("last14", "UTC", NOW)).toEqual({ from: "2026-10-21", to: "2026-11-03" });
    expect(daysIn(rangeFor("last14", "UTC", NOW))).toBe(14);
  });
  it("the previous range is the same number of days straight before", () => {
    expect(previousRange({ from: "2026-10-21", to: "2026-11-03" })).toEqual({ from: "2026-10-07", to: "2026-10-20" });
    expect(previousRange({ from: "2026-11-03", to: "2026-11-03" })).toEqual({ from: "2026-11-02", to: "2026-11-02" });
  });
  it("says up, down or nothing when there is nothing to compare with", () => {
    expect(changeText(112, 100)).toBe("Up 12%");
    expect(changeText(92, 100)).toBe("Down 8%");
    expect(changeText(100, 100)).toBe("No change");
    expect(changeText(50, 0)).toBe("");
    expect(changeText(NaN, 10)).toBe("");
  });
});

describe("change text", () => {
  it("caps a meaningless percentage against a tiny earlier number", () => {
    expect(changeText(13218, 100)).toBe("Up 999%+");
    expect(changeText(150, 100)).toBe("Up 50%");
    expect(changeText(100, 100)).toBe("No change");
  });
});
