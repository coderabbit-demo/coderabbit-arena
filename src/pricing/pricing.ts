import { Cents, PriceBreakdown, PricingRules, QuoteInput, Weekday } from "./types";

const MINUTES_PER_HOUR = 60;
const MS_PER_MINUTE = 60 * 1000;

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingError";
  }
}

/** Saturday (6) and Sunday (0) are treated as weekend days. */
export function isWeekend(day: Weekday): boolean {
  return day === 0 || day === 6;
}

/** Whether a given UTC hour falls inside the configured peak window. */
export function isPeakHour(hour: number, rules: PricingRules): boolean {
  return hour >= rules.peakStartHour && hour < rules.peakEndHour;
}

function validateRules(rules: PricingRules): void {
  if (rules.hourlyRateCents < 0) {
    throw new PricingError("hourlyRateCents must not be negative");
  }
  if (rules.peakMultiplier < 1) {
    throw new PricingError("peakMultiplier must be at least 1");
  }
  if (rules.weekendSurcharge < 0) {
    throw new PricingError("weekendSurcharge must not be negative");
  }
  if (
    rules.peakStartHour < 0 ||
    rules.peakEndHour > 24 ||
    rules.peakStartHour > rules.peakEndHour
  ) {
    throw new PricingError("peak window is out of range");
  }
}

/**
 * Split a booking into per-minute buckets and count how many minutes fall in
 * the peak window vs off-peak. Walking minute-by-minute keeps the peak
 * boundary exact even when a booking straddles it.
 */
function splitMinutes(
  start: Date,
  end: Date,
  rules: PricingRules,
): { peak: number; offPeak: number } {
  let peak = 0;
  let offPeak = 0;

  const totalMinutes = Math.round((end.getTime() - start.getTime()) / MS_PER_MINUTE);
  for (let i = 0; i < totalMinutes; i++) {
    const at = new Date(start.getTime() + i * MS_PER_MINUTE);
    if (isPeakHour(at.getUTCHours(), rules)) {
      peak += 1;
    } else {
      offPeak += 1;
    }
  }

  return { peak, offPeak };
}

function minutesToCents(minutes: number, hourlyRateCents: Cents): Cents {
  return (minutes / MINUTES_PER_HOUR) * hourlyRateCents;
}

/**
 * Produce a full price breakdown for a booking. The order of operations is:
 * per-minute peak/off-peak subtotal → weekend surcharge → discount →
 * minimum-charge floor. All returned amounts are rounded to whole cents.
 */
export function quote(input: QuoteInput): PriceBreakdown {
  const { start, end, rules } = input;

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new PricingError("start and end must be valid dates");
  }
  if (end.getTime() <= start.getTime()) {
    throw new PricingError("end must be after start");
  }
  validateRules(rules);

  const discountRate = input.discountRate ?? 0;
  if (discountRate < 0 || discountRate > 1) {
    throw new PricingError("discountRate must be between 0 and 1");
  }

  const { peak, offPeak } = splitMinutes(start, end, rules);
  const minutes = peak + offPeak;

  const offPeakCents = minutesToCents(offPeak, rules.hourlyRateCents);
  const peakCents =
    minutesToCents(peak, rules.hourlyRateCents) * rules.peakMultiplier;

  const subtotal = offPeakCents + peakCents;

  const surchargeCents = isWeekend(start.getUTCDay() as Weekday)
    ? subtotal * rules.weekendSurcharge
    : 0;

  const discountCents = (subtotal + surchargeCents) * discountRate;

  const rawTotal = subtotal + surchargeCents - discountCents;
  const totalCents = Math.max(Math.round(rawTotal), rules.minimumChargeCents);

  return {
    minutes,
    offPeakCents: Math.round(offPeakCents),
    peakCents: Math.round(peakCents),
    surchargeCents: Math.round(surchargeCents),
    discountCents: Math.round(discountCents),
    totalCents,
  };
}

/** Format a cents amount as a currency string, e.g. 1250 -> "$12.50". */
export function formatCents(cents: Cents, symbol = "$"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const remainder = (abs % 100).toString().padStart(2, "0");
  return `${sign}${symbol}${dollars}.${remainder}`;
}
