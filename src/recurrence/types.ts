import { Weekday } from "../pricing/types";

/** How often a recurring booking repeats. */
export type Frequency = "daily" | "weekly";

/**
 * Describes a repeating booking pattern. The first occurrence always starts at
 * the base booking's start; subsequent occurrences are offset by `interval`
 * units of `frequency`.
 */
export interface RecurrenceRule {
  frequency: Frequency;
  /** Repeat every `interval` days/weeks. Must be a positive integer. */
  interval: number;
  /** Total number of occurrences to generate, including the first. */
  count: number;
  /**
   * For weekly rules, restrict occurrences to these weekdays (0 = Sunday).
   * When omitted, the weekday of the base start is used.
   */
  weekdays?: Weekday[];
}

/** A single generated occurrence of a recurring booking. */
export interface Occurrence {
  /** Zero-based index of this occurrence within the series. */
  index: number;
  start: Date;
  end: Date;
}

export interface ExpandInput {
  /** Start of the first occurrence. */
  start: Date;
  /** End of the first occurrence. */
  end: Date;
  rule: RecurrenceRule;
}

export class RecurrenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecurrenceError";
  }
}
