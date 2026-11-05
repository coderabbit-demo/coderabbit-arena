import { Weekday } from "../pricing/types";
import {
  ExpandInput,
  Frequency,
  Occurrence,
  RecurrenceError,
  RecurrenceRule,
} from "./types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_WEEK = 7;
const MAX_OCCURRENCES = 366;

function validateRule(rule: RecurrenceRule): void {
  if (rule.frequency !== "daily" && rule.frequency !== "weekly") {
    throw new RecurrenceError(`Unknown frequency: ${rule.frequency}`);
  }
  if (!Number.isInteger(rule.interval) || rule.interval < 1) {
    throw new RecurrenceError("interval must be a positive integer");
  }
  if (!Number.isInteger(rule.count) || rule.count < 1) {
    throw new RecurrenceError("count must be a positive integer");
  }
  if (rule.count > MAX_OCCURRENCES) {
    throw new RecurrenceError(
      `count must not exceed ${MAX_OCCURRENCES} occurrences`,
    );
  }
  if (rule.weekdays) {
    if (rule.frequency !== "weekly") {
      throw new RecurrenceError("weekdays may only be set for weekly rules");
    }
    if (rule.weekdays.length === 0) {
      throw new RecurrenceError("weekdays must not be empty when provided");
    }
    for (const day of rule.weekdays) {
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        throw new RecurrenceError(`invalid weekday: ${day}`);
      }
    }
  }
}

/** Shift a date forward by a whole number of days, preserving the time. */
function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/**
 * Distance in days from `from` forward to the next occurrence of `target`
 * weekday. Returns 0 when `from` already falls on `target`.
 */
function daysUntilWeekday(from: Weekday, target: Weekday): number {
  return (target - from + DAYS_PER_WEEK) % DAYS_PER_WEEK;
}

function expandDaily(input: ExpandInput): Occurrence[] {
  const { start, end, rule } = input;
  const duration = end.getTime() - start.getTime();
  const occurrences: Occurrence[] = [];

  for (let i = 0; i < rule.count; i++) {
    const occStart = addDays(start, i * rule.interval);
    occurrences.push({
      index: i,
      start: occStart,
      end: new Date(occStart.getTime() + duration),
    });
  }

  return occurrences;
}

function expandWeekly(input: ExpandInput): Occurrence[] {
  const { start, end, rule } = input;
  const duration = end.getTime() - start.getTime();
  const baseWeekday = start.getUTCDay() as Weekday;
  const weekdays = rule.weekdays ?? [baseWeekday];
  // Order by forward distance from the base weekday so occurrences come out
  // chronologically and never land before the series start.
  const offsets = weekdays
    .map((day) => daysUntilWeekday(baseWeekday, day))
    .sort((a, b) => a - b);

  const occurrences: Occurrence[] = [];
  let index = 0;

  for (let week = 0; occurrences.length < rule.count; week++) {
    const weekStart = addDays(start, week * rule.interval * DAYS_PER_WEEK);
    for (const offset of offsets) {
      if (occurrences.length >= rule.count) {
        break;
      }
      const occStart = addDays(weekStart, offset);
      occurrences.push({
        index: index++,
        start: occStart,
        end: new Date(occStart.getTime() + duration),
      });
    }
  }

  return occurrences;
}

/**
 * Expand a recurrence rule into a concrete list of occurrences. Each occurrence
 * keeps the same duration as the base interval. Daily rules step by whole days;
 * weekly rules step by whole weeks and may target specific weekdays.
 */
export function expand(input: ExpandInput): Occurrence[] {
  const { start, end, rule } = input;

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new RecurrenceError("start and end must be valid dates");
  }
  if (end.getTime() <= start.getTime()) {
    throw new RecurrenceError("end must be after start");
  }
  validateRule(rule);

  const expander: Record<Frequency, (input: ExpandInput) => Occurrence[]> = {
    daily: expandDaily,
    weekly: expandWeekly,
  };

  const occurrences = expander[rule.frequency](input);
  if (occurrences.some(({ start, end }) =>
    Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()),
  )) {
    throw new RecurrenceError("generated occurrence has an invalid date");
  }
  return occurrences;
}

/** Human-readable one-line summary of a recurrence rule, e.g. "every 2 weeks, 5 times". */
export function describeRule(rule: RecurrenceRule): string {
  const unit = rule.frequency === "daily" ? "day" : "week";
  const every =
    rule.interval === 1 ? `every ${unit}` : `every ${rule.interval} ${unit}s`;
  return `${every}, ${rule.count} times`;
}
