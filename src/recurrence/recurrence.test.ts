import { describe, expect, it } from "vitest";
import { describeRule, expand } from "./recurrence";
import { RecurrenceError, RecurrenceRule } from "./types";

const start = new Date("2026-08-05T09:00:00.000Z"); // Wednesday
const end = new Date("2026-08-05T10:00:00.000Z");

describe("expand daily", () => {
  it("generates consecutive days at the same time", () => {
    const rule: RecurrenceRule = { frequency: "daily", interval: 1, count: 3 };
    const occ = expand({ start, end, rule });

    expect(occ).toHaveLength(3);
    expect(occ[0].start.toISOString()).toBe("2026-08-05T09:00:00.000Z");
    expect(occ[1].start.toISOString()).toBe("2026-08-06T09:00:00.000Z");
    expect(occ[2].start.toISOString()).toBe("2026-08-07T09:00:00.000Z");
  });

  it("respects the interval", () => {
    const rule: RecurrenceRule = { frequency: "daily", interval: 2, count: 3 };
    const occ = expand({ start, end, rule });

    expect(occ.map((o) => o.start.toISOString())).toEqual([
      "2026-08-05T09:00:00.000Z",
      "2026-08-07T09:00:00.000Z",
      "2026-08-09T09:00:00.000Z",
    ]);
  });

  it("preserves the booking duration on every occurrence", () => {
    const rule: RecurrenceRule = { frequency: "daily", interval: 1, count: 2 };
    const occ = expand({ start, end, rule });

    for (const o of occ) {
      expect(o.end.getTime() - o.start.getTime()).toBe(60 * 60 * 1000);
    }
  });
});

describe("expand weekly", () => {
  it("defaults to the base weekday", () => {
    const rule: RecurrenceRule = { frequency: "weekly", interval: 1, count: 2 };
    const occ = expand({ start, end, rule });

    expect(occ.map((o) => o.start.toISOString())).toEqual([
      "2026-08-05T09:00:00.000Z",
      "2026-08-12T09:00:00.000Z",
    ]);
  });

  it("expands multiple weekdays in chronological order", () => {
    // Wednesday (3) base, also book Fridays (5) and Mondays (1). Occurrences
    // run forward from the start, so the first Monday is next week's.
    const rule: RecurrenceRule = {
      frequency: "weekly",
      interval: 1,
      count: 4,
      weekdays: [5, 1, 3],
    };
    const occ = expand({ start, end, rule });

    expect(occ.map((o) => o.start.toISOString())).toEqual([
      "2026-08-05T09:00:00.000Z", // Wed (base)
      "2026-08-07T09:00:00.000Z", // Fri
      "2026-08-10T09:00:00.000Z", // next Mon
      "2026-08-12T09:00:00.000Z", // next Wed
    ]);
  });

  it("skips weeks according to the interval", () => {
    const rule: RecurrenceRule = { frequency: "weekly", interval: 3, count: 2 };
    const occ = expand({ start, end, rule });

    expect(occ.map((o) => o.start.toISOString())).toEqual([
      "2026-08-05T09:00:00.000Z",
      "2026-08-26T09:00:00.000Z",
    ]);
  });
});

describe("expand validation", () => {
  it("rejects an inverted range", () => {
    const rule: RecurrenceRule = { frequency: "daily", interval: 1, count: 1 };
    expect(() => expand({ start: end, end: start, rule })).toThrow(
      RecurrenceError,
    );
  });

  it("rejects a non-positive interval", () => {
    const rule: RecurrenceRule = { frequency: "daily", interval: 0, count: 1 };
    expect(() => expand({ start, end, rule })).toThrow(RecurrenceError);
  });

  it("rejects an excessive count", () => {
    const rule: RecurrenceRule = {
      frequency: "daily",
      interval: 1,
      count: 10000,
    };
    expect(() => expand({ start, end, rule })).toThrow(RecurrenceError);
  });

  it("rejects weekdays on a daily rule", () => {
    const rule: RecurrenceRule = {
      frequency: "daily",
      interval: 1,
      count: 1,
      weekdays: [1],
    };
    expect(() => expand({ start, end, rule })).toThrow(RecurrenceError);
  });

  it("rejects an invalid weekday", () => {
    const rule: RecurrenceRule = {
      frequency: "weekly",
      interval: 1,
      count: 1,
      weekdays: [9 as unknown as 0],
    };
    expect(() => expand({ start, end, rule })).toThrow(RecurrenceError);
  });
});

describe("describeRule", () => {
  it("describes singular and plural intervals", () => {
    expect(describeRule({ frequency: "daily", interval: 1, count: 3 })).toBe(
      "every day, 3 times",
    );
    expect(describeRule({ frequency: "weekly", interval: 2, count: 5 })).toBe(
      "every 2 weeks, 5 times",
    );
  });
});
