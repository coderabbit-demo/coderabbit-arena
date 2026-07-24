import { describe, expect, it } from "vitest";
import { reportToMarkdown } from "./markdown";
import { UtilizationReport } from "./types";

const window = {
  from: "2026-08-05T00:00:00.000Z",
  to: "2026-08-06T00:00:00.000Z",
};

function report(overrides: Partial<UtilizationReport> = {}): UtilizationReport {
  return {
    window,
    resources: [
      {
        resourceId: "a",
        resourceName: "Room A",
        bookingCount: 2,
        bookedMinutes: 720,
        capacityMinutes: 1440,
        utilization: 0.5,
        revenueCents: 12000,
      },
    ],
    totalRevenueCents: 12000,
    averageUtilization: 0.5,
    ...overrides,
  };
}

describe("reportToMarkdown", () => {
  it("includes a title with the reporting window", () => {
    const lines = reportToMarkdown(report()).split("\n");
    expect(lines[0]).toBe(
      "### Utilization 2026-08-05T00:00:00.000Z → 2026-08-06T00:00:00.000Z",
    );
  });

  it("renders a header and separator row", () => {
    const lines = reportToMarkdown(report()).split("\n");
    expect(lines[2]).toBe(
      "| Resource | Bookings | Booked (min) | Capacity (min) | Utilization | Revenue |",
    );
    expect(lines[3]).toBe("| --- | --- | --- | --- | --- | --- |");
  });

  it("renders a resource row with formatted values", () => {
    const lines = reportToMarkdown(report()).split("\n");
    expect(lines[4]).toBe("| Room A | 2 | 720 | 1440 | 50% | $120.00 |");
  });

  it("appends a bold Total row with aggregated bookings", () => {
    const r = report({
      resources: [
        {
          resourceId: "a",
          resourceName: "Room A",
          bookingCount: 2,
          bookedMinutes: 720,
          capacityMinutes: 1440,
          utilization: 0.5,
          revenueCents: 12000,
        },
        {
          resourceId: "b",
          resourceName: "Room B",
          bookingCount: 3,
          bookedMinutes: 1440,
          capacityMinutes: 2880,
          utilization: 0.5,
          revenueCents: 8000,
        },
      ],
      totalRevenueCents: 20000,
      averageUtilization: 0.5,
    });
    const lines = reportToMarkdown(r).split("\n");
    expect(lines[lines.length - 1]).toBe(
      "| **Total** | 5 |  |  | 50% | $200.00 |",
    );
  });

  it("escapes pipe characters in resource names", () => {
    const r = report({
      resources: [
        {
          resourceId: "a",
          resourceName: "Room A | B",
          bookingCount: 1,
          bookedMinutes: 60,
          capacityMinutes: 1440,
          utilization: 0.04,
          revenueCents: 6000,
        },
      ],
    });
    const lines = reportToMarkdown(r).split("\n");
    expect(lines[4]).toContain("Room A \\| B");
  });
});
