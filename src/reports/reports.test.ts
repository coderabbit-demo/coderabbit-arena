import { describe, expect, it } from "vitest";
import { buildUtilizationReport, formatUtilization } from "./reports";
import { ReportError } from "./types";
import { Booking, Resource } from "../domain/types";
import { PricingRules } from "../pricing/types";

const rules: PricingRules = {
  hourlyRateCents: 6000, // $60/hour
  peakStartHour: 9,
  peakEndHour: 17,
  peakMultiplier: 1.5,
  weekendSurcharge: 0.2,
  minimumChargeCents: 0,
};

const roomA: Resource = { id: "a", name: "Room A", capacity: 1, createdBy: "key-admin" };
const roomB: Resource = { id: "b", name: "Room B", capacity: 2, createdBy: "key-admin" };

function booking(
  resourceId: string,
  start: string,
  end: string,
  status: Booking["status"] = "confirmed",
): Booking {
  return {
    id: `${resourceId}-${start}`,
    resourceId,
    bookedBy: "Ada",
    start,
    end,
    status,
    createdAt: "2026-08-01T00:00:00.000Z",
    createdBy: "key-admin",
  };
}

// A single 24h day window: Wed 2026-08-05.
const window = {
  from: "2026-08-05T00:00:00.000Z",
  to: "2026-08-06T00:00:00.000Z",
};

describe("buildUtilizationReport", () => {
  it("computes booked minutes and utilization for a resource", () => {
    const bookings = [
      booking("a", "2026-08-05T09:00:00.000Z", "2026-08-05T12:00:00.000Z"),
    ];
    const report = buildUtilizationReport(
      [roomA],
      () => bookings,
      { window },
    );

    const a = report.resources[0];
    expect(a.bookingCount).toBe(1);
    expect(a.bookedMinutes).toBe(180);
    expect(a.capacityMinutes).toBe(1440); // 24h * capacity 1
    expect(a.utilization).toBeCloseTo(180 / 1440);
  });

  it("clips bookings that extend past the window", () => {
    const bookings = [
      // Starts the evening before; only 02:00 of it lands inside the window.
      booking("a", "2026-08-04T22:00:00.000Z", "2026-08-05T02:00:00.000Z"),
    ];
    const report = buildUtilizationReport([roomA], () => bookings, { window });
    expect(report.resources[0].bookedMinutes).toBe(120);
  });

  it("caps booked minutes at the resource capacity", () => {
    const bookings = [
      booking("b", "2026-08-05T00:00:00.000Z", "2026-08-06T00:00:00.000Z"),
      booking("b", "2026-08-05T00:00:00.000Z", "2026-08-06T00:00:00.000Z"),
      booking("b", "2026-08-05T00:00:00.000Z", "2026-08-06T00:00:00.000Z"),
    ];
    const report = buildUtilizationReport([roomB], () => bookings, { window });
    const b = report.resources[0];
    // 3 full-day bookings = 4320 min, capped at capacity 2 * 1440 = 2880.
    expect(b.bookedMinutes).toBe(2880);
    expect(b.utilization).toBe(1);
  });

  it("estimates revenue when pricing rules are supplied", () => {
    const bookings = [
      // 07:00-08:00 off-peak = $60 = 6000 cents.
      booking("a", "2026-08-05T07:00:00.000Z", "2026-08-05T08:00:00.000Z"),
    ];
    const report = buildUtilizationReport([roomA], () => bookings, {
      window,
      rules,
    });
    expect(report.resources[0].revenueCents).toBe(6000);
    expect(report.totalRevenueCents).toBe(6000);
  });

  it("reports zero revenue without pricing rules", () => {
    const bookings = [
      booking("a", "2026-08-05T07:00:00.000Z", "2026-08-05T08:00:00.000Z"),
    ];
    const report = buildUtilizationReport([roomA], () => bookings, { window });
    expect(report.resources[0].revenueCents).toBe(0);
  });

  it("weights average utilization by capacity", () => {
    const byResource: Record<string, Booking[]> = {
      a: [booking("a", "2026-08-05T00:00:00.000Z", "2026-08-05T12:00:00.000Z")],
      b: [],
    };
    const report = buildUtilizationReport(
      [roomA, roomB],
      (id) => byResource[id] ?? [],
      { window },
    );
    // Room A: 720 booked / 1440 capacity. Room B: 0 / 2880.
    // Weighted: 720 / (1440 + 2880) = 720 / 4320.
    expect(report.averageUtilization).toBeCloseTo(720 / 4320);
  });

  it("rejects an inverted window", () => {
    expect(() =>
      buildUtilizationReport([roomA], () => [], {
        window: { from: window.to, to: window.from },
      }),
    ).toThrow(ReportError);
  });

  it("rejects an invalid timestamp", () => {
    expect(() =>
      buildUtilizationReport([roomA], () => [], {
        window: { from: "not-a-date", to: window.to },
      }),
    ).toThrow(ReportError);
  });
});

describe("formatUtilization", () => {
  it("renders a ratio as a rounded percentage", () => {
    expect(formatUtilization(0)).toBe("0%");
    expect(formatUtilization(0.5)).toBe("50%");
    expect(formatUtilization(0.427)).toBe("43%");
    expect(formatUtilization(1)).toBe("100%");
  });
});
