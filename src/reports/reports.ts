import { Booking, Resource, TimeRange } from "../domain/types";
import { overlaps, parseRange } from "../domain/time";
import { quote } from "../pricing/pricing";
import { PricingRules } from "../pricing/types";
import {
  ReportError,
  ReportInput,
  ReportWindow,
  ResourceUtilization,
  UtilizationReport,
} from "./types";

const MS_PER_MINUTE = 60 * 1000;

/** Parse and validate a reporting window into a concrete time range. */
function parseWindow(window: ReportWindow): TimeRange {
  const from = new Date(window.from);
  const to = new Date(window.to);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new ReportError("window bounds must be valid ISO-8601 timestamps");
  }
  if (to.getTime() <= from.getTime()) {
    throw new ReportError("window 'to' must be after 'from'");
  }

  return { start: from, end: to };
}

/**
 * The portion of a booking that falls inside the window, as a time range.
 * Returns null when the booking does not intersect the window at all.
 */
function clipToWindow(booking: Booking, window: TimeRange): TimeRange | null {
  const range = parseRange(booking.start, booking.end);
  if (!overlaps(range, window)) {
    return null;
  }
  const start = new Date(
    Math.max(range.start.getTime(), window.start.getTime()),
  );
  const end = new Date(Math.min(range.end.getTime(), window.end.getTime()));
  return { start, end };
}

function minutesBetween(range: TimeRange): number {
  return Math.round((range.end.getTime() - range.start.getTime()) / MS_PER_MINUTE);
}

/**
 * Compute utilization for a single resource. Booked minutes are summed from the
 * window-clipped confirmed bookings and capped at the resource's total capacity
 * so an over-subscribed slot never reports above 100%.
 */
function utilizationForResource(
  resource: Resource,
  bookings: Booking[],
  window: TimeRange,
  rules: PricingRules | undefined,
): ResourceUtilization {
  const windowMinutes = minutesBetween(window);
  const capacityMinutes = windowMinutes * resource.capacity;

  let bookedMinutes = 0;
  let revenueCents = 0;
  let bookingCount = 0;

  for (const booking of bookings) {
    const clipped = clipToWindow(booking, window);
    if (!clipped) {
      continue;
    }
    bookingCount += 1;
    bookedMinutes += minutesBetween(clipped);

    if (rules) {
      revenueCents += quote({
        start: clipped.start,
        end: clipped.end,
        rules,
      }).totalCents;
    }
  }

  bookedMinutes = Math.min(bookedMinutes, capacityMinutes);

  return {
    resourceId: resource.id,
    resourceName: resource.name,
    bookingCount,
    bookedMinutes,
    capacityMinutes,
    utilization: bookedMinutes / capacityMinutes,
    revenueCents,
  };
}

/**
 * Build a utilization report across every resource for the given window.
 * `getBookings` returns the confirmed bookings for a resource id.
 */
export function buildUtilizationReport(
  resources: Resource[],
  getBookings: (resourceId: string) => Booking[],
  input: ReportInput,
): UtilizationReport {
  const window = parseWindow(input.window);

  const perResource = resources.map((resource) =>
    utilizationForResource(
      resource,
      getBookings(resource.id),
      window,
      input.rules,
    ),
  );

  const totalRevenueCents = perResource.reduce(
    (sum, r) => sum + r.revenueCents,
    0,
  );

  const totalCapacity = perResource.reduce(
    (sum, r) => sum + r.capacityMinutes,
    0,
  );
  const totalBooked = perResource.reduce((sum, r) => sum + r.bookedMinutes, 0);
  const averageUtilization = totalCapacity === 0 ? 0 : totalBooked / totalCapacity;

  return {
    window: input.window,
    resources: perResource,
    totalRevenueCents,
    averageUtilization,
  };
}

/** Render a utilization ratio (0..1) as a rounded percentage string, e.g. "42%". */
export function formatUtilization(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
