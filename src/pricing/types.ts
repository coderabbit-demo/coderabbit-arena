/** Currency amounts are represented in integer minor units (e.g. cents). */
export type Cents = number;

/** Days of the week, 0 = Sunday .. 6 = Saturday (matches Date.getUTCDay). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface PricingRules {
  /** Base rate charged per hour, in cents. */
  hourlyRateCents: Cents;
  /** Inclusive UTC hour at which peak pricing starts (0-23). */
  peakStartHour: number;
  /** Exclusive UTC hour at which peak pricing ends (0-23). */
  peakEndHour: number;
  /** Multiplier applied to hours that fall in the peak window. */
  peakMultiplier: number;
  /** Extra fraction added to the whole booking on weekends (e.g. 0.15 = +15%). */
  weekendSurcharge: number;
  /** Minimum total charge, in cents, applied after all other rules. */
  minimumChargeCents: Cents;
}

export interface PriceBreakdown {
  /** Total billable minutes. */
  minutes: number;
  /** Cost of off-peak minutes, in cents (before surcharge/discount). */
  offPeakCents: Cents;
  /** Cost of peak minutes, in cents (before surcharge/discount). */
  peakCents: Cents;
  /** Weekend surcharge applied, in cents. */
  surchargeCents: Cents;
  /** Discount applied, in cents (non-negative). */
  discountCents: Cents;
  /** Final total, in cents, after surcharge, discount and the minimum charge. */
  totalCents: Cents;
}

export interface QuoteInput {
  start: Date;
  end: Date;
  rules: PricingRules;
  /** Optional discount as a fraction of the subtotal (0..1). */
  discountRate?: number;
}
