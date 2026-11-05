import { describe, expect, it } from "vitest";
import { formatCents, isPeakHour, isWeekend, PricingError, quote } from "./pricing";
import { PricingRules } from "./types";

const rules: PricingRules = {
  hourlyRateCents: 6000, // $60/hour
  peakStartHour: 9,
  peakEndHour: 17,
  peakMultiplier: 1.5,
  weekendSurcharge: 0.2,
  minimumChargeCents: 1000,
};

describe("isWeekend", () => {
  it("treats Saturday and Sunday as weekend", () => {
    expect(isWeekend(0)).toBe(true);
    expect(isWeekend(6)).toBe(true);
  });

  it("treats weekdays as non-weekend", () => {
    for (const d of [1, 2, 3, 4, 5] as const) {
      expect(isWeekend(d)).toBe(false);
    }
  });
});

describe("isPeakHour", () => {
  it("includes the start hour and excludes the end hour", () => {
    expect(isPeakHour(9, rules)).toBe(true);
    expect(isPeakHour(16, rules)).toBe(true);
    expect(isPeakHour(17, rules)).toBe(false);
    expect(isPeakHour(8, rules)).toBe(false);
  });
});

describe("quote", () => {
  it("prices a one-hour off-peak weekday booking at the base rate", () => {
    // Wed 2026-08-05, 07:00-08:00 UTC (before peak).
    const result = quote({
      start: new Date("2026-08-05T07:00:00.000Z"),
      end: new Date("2026-08-05T08:00:00.000Z"),
      rules,
    });
    expect(result.minutes).toBe(60);
    expect(result.offPeakCents).toBe(6000);
    expect(result.peakCents).toBe(0);
    expect(result.totalCents).toBe(6000);
  });

  it("applies the peak multiplier to peak minutes", () => {
    // Wed 2026-08-05, 09:00-10:00 UTC (fully peak).
    const result = quote({
      start: new Date("2026-08-05T09:00:00.000Z"),
      end: new Date("2026-08-05T10:00:00.000Z"),
      rules,
    });
    expect(result.peakCents).toBe(9000); // 6000 * 1.5
    expect(result.totalCents).toBe(9000);
  });

  it("splits a booking that straddles the peak boundary", () => {
    // Wed 2026-08-05, 08:30-09:30 UTC: 30m off-peak + 30m peak.
    const result = quote({
      start: new Date("2026-08-05T08:30:00.000Z"),
      end: new Date("2026-08-05T09:30:00.000Z"),
      rules,
    });
    expect(result.offPeakCents).toBe(3000); // 30m @ $60/h
    expect(result.peakCents).toBe(4500); // 30m @ $60/h * 1.5
    expect(result.totalCents).toBe(7500);
  });

  it("adds the weekend surcharge on Saturday", () => {
    // Sat 2026-08-01, 07:00-08:00 UTC (off-peak).
    const result = quote({
      start: new Date("2026-08-01T07:00:00.000Z"),
      end: new Date("2026-08-01T08:00:00.000Z"),
      rules,
    });
    expect(result.surchargeCents).toBe(1200); // 6000 * 0.2
    expect(result.totalCents).toBe(7200);
  });

  it.each([
    // Preserve rounding and sampling from the booking's start, including seconds.
    ["2026-08-05T08:59:45Z", "2026-08-05T09:00:14Z", 0, 0],
    ["2026-08-05T08:59:45Z", "2026-08-05T09:00:15Z", 1, 0],
    ["2026-08-05T08:59:45Z", "2026-08-05T09:01:15Z", 1, 1],
    ["2026-08-05T16:59:45Z", "2026-08-05T17:01:15Z", 1, 1],
    ["2026-08-05T16:30:00Z", "2026-08-06T09:30:00Z", 960, 60],
    ["2026-08-05T16:30:00Z", "2026-08-08T09:30:00Z", 2880, 1020],
    ["1969-12-31T23:30:00Z", "1970-01-01T09:30:00Z", 570, 30],
  ])("preserves minute pricing from %s to %s", (from, to, offPeak, peak) => {
    const result = quote({ start: new Date(from), end: new Date(to), rules });
    expect(result.minutes).toBe(offPeak + peak);
    expect(result.offPeakCents).toBe(offPeak * 100);
    expect(result.peakCents).toBe(peak * 150);
  });

  it.each([
    [0, 24, 1440],
    [9, 9, 0],
    [24, 24, 0],
    [9.5, 17.5, 480],
    [9.1, 9.9, 0],
  ])("prices a day with peak hours %s to %s", (peakStartHour, peakEndHour, peak) => {
    const result = quote({
      start: new Date("2026-08-05T12:34:56.789Z"),
      end: new Date("2026-08-06T12:34:56.789Z"),
      rules: { ...rules, peakStartHour, peakEndHour },
    });
    expect(result.minutes).toBe(1440);
    expect(result.peakCents).toBe(peak * 150);
    expect(result.offPeakCents).toBe((1440 - peak) * 100);
  });

  it("prices the entire valid Date range without iterating over its minutes", () => {
    const result = quote({
      start: new Date(-8640000000000000),
      end: new Date(8640000000000000),
      rules: { ...rules, weekendSurcharge: 0 },
    });
    const days = 200000000;
    expect(result.minutes).toBe(days * 1440);
    expect(result.peakCents).toBe(days * 480 * 150);
    expect(result.offPeakCents).toBe(days * 960 * 100);
    expect(result.totalCents).toBe(days * 168000);
  });

  it("applies a discount after the surcharge", () => {
    const result = quote({
      start: new Date("2026-08-01T07:00:00.000Z"),
      end: new Date("2026-08-01T08:00:00.000Z"),
      rules,
      discountRate: 0.1,
    });
    // subtotal 6000 + surcharge 1200 = 7200; 10% off = 720 discount.
    expect(result.discountCents).toBe(720);
    expect(result.totalCents).toBe(6480);
  });

  it("floors the total at the minimum charge", () => {
    // 5 minutes off-peak = 500 cents, below the 1000 minimum.
    const result = quote({
      start: new Date("2026-08-05T07:00:00.000Z"),
      end: new Date("2026-08-05T07:05:00.000Z"),
      rules,
    });
    expect(result.totalCents).toBe(1000);
  });

  it("rejects an inverted range", () => {
    expect(() =>
      quote({
        start: new Date("2026-08-05T08:00:00.000Z"),
        end: new Date("2026-08-05T07:00:00.000Z"),
        rules,
      }),
    ).toThrow(PricingError);
  });

  it("rejects an out-of-bounds discount", () => {
    expect(() =>
      quote({
        start: new Date("2026-08-05T07:00:00.000Z"),
        end: new Date("2026-08-05T08:00:00.000Z"),
        rules,
        discountRate: 1.5,
      }),
    ).toThrow(PricingError);
  });
});

describe("formatCents", () => {
  it("formats whole and fractional amounts", () => {
    expect(formatCents(1250)).toBe("$12.50");
    expect(formatCents(6000)).toBe("$60.00");
    expect(formatCents(5)).toBe("$0.05");
  });

  it("handles negative amounts and custom symbols", () => {
    expect(formatCents(-1250)).toBe("-$12.50");
    expect(formatCents(1250, "€")).toBe("€12.50");
  });
});
