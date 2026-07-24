import { describe, expect, it } from "vitest";
import { reportToCsv } from "./csv";
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

describe("reportToCsv", () => {
  it("emits a header row", () => {
    const lines = reportToCsv(report()).split("\r\n");
    expect(lines[0]).toBe(
      "resourceId,resourceName,bookingCount,bookedMinutes,capacityMinutes,utilization,revenue",
    );
  });

  it("renders a resource row with formatted utilization and revenue", () => {
    const lines = reportToCsv(report()).split("\r\n");
    expect(lines[1]).toBe("a,Room A,2,720,1440,50%,$120.00");
  });

  it("appends a TOTAL row with aggregated booking count", () => {
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
    const lines = reportToCsv(r).split("\r\n");
    expect(lines[lines.length - 1]).toBe("TOTAL,,5,,,50%,$200.00");
  });

  it("quotes fields containing commas", () => {
    const r = report({
      resources: [
        {
          resourceId: "a",
          resourceName: "Room A, East Wing",
          bookingCount: 1,
          bookedMinutes: 60,
          capacityMinutes: 1440,
          utilization: 0.04,
          revenueCents: 6000,
        },
      ],
    });
    const lines = reportToCsv(r).split("\r\n");
    expect(lines[1]).toContain('"Room A, East Wing"');
  });

  it("escapes embedded double quotes", () => {
    const r = report({
      resources: [
        {
          resourceId: "a",
          resourceName: 'The "Big" Room',
          bookingCount: 1,
          bookedMinutes: 60,
          capacityMinutes: 1440,
          utilization: 0.04,
          revenueCents: 6000,
        },
      ],
    });
    const lines = reportToCsv(r).split("\r\n");
    expect(lines[1]).toContain('"The ""Big"" Room"');
  });

  it("prefixes formula-like fields with an apostrophe to prevent CSV injection", () => {
    const r = report({
      resources: [
        {
          resourceId: "a",
          resourceName: "=SUM(A1:A9)",
          bookingCount: 1,
          bookedMinutes: 60,
          capacityMinutes: 1440,
          utilization: 0.04,
          revenueCents: 6000,
        },
      ],
    });
    const lines = reportToCsv(r).split("\r\n");
    expect(lines[1]).toBe("a,'=SUM(A1:A9),1,60,1440,4%,$60.00");
  });

  it("prefixes whitespace-led formula payloads with an apostrophe", () => {
    const r = report({
      resources: [
        {
          resourceId: "a",
          resourceName: "  +cmd|' /C calc'!A0",
          bookingCount: 1,
          bookedMinutes: 60,
          capacityMinutes: 1440,
          utilization: 0.04,
          revenueCents: 6000,
        },
      ],
    });
    const lines = reportToCsv(r).split("\r\n");
    expect(lines[1]).toContain("'  +cmd");
  });

  it("produces only a header and TOTAL row when there are no resources", () => {
    const r = report({
      resources: [],
      totalRevenueCents: 0,
      averageUtilization: 0,
    });
    const lines = reportToCsv(r).split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("TOTAL,,0,,,0%,$0.00");
  });
});
