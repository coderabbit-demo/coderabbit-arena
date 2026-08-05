import { Cents, PricingRules } from "../pricing/types";

/** A closed-open reporting window expressed as ISO-8601 strings. */
export interface ReportWindow {
  /** Inclusive start of the window (ISO-8601). */
  from: string;
  /** Exclusive end of the window (ISO-8601). */
  to: string;
}

/** Utilization figures for a single resource over the reporting window. */
export interface ResourceUtilization {
  resourceId: string;
  resourceName: string;
  /** Confirmed bookings that intersect the window. */
  bookingCount: number;
  /** Booked minutes, clipped to the window and capped at the resource capacity. */
  bookedMinutes: number;
  /** Minutes the resource could be booked across the window (capacity * span). */
  capacityMinutes: number;
  /** bookedMinutes / capacityMinutes, in the range 0..1. */
  utilization: number;
  /** Estimated revenue over the window, in cents, using the pricing rules. */
  revenueCents: Cents;
}

/** A full utilization report across every resource. */
export interface UtilizationReport {
  window: ReportWindow;
  resources: ResourceUtilization[];
  /** Sum of revenue across all resources, in cents. */
  totalRevenueCents: Cents;
  /** Capacity-weighted mean utilization across all resources (0..1). */
  averageUtilization: number;
}

export interface ReportInput {
  window: ReportWindow;
  /** Pricing rules used to estimate revenue; when omitted, revenue is 0. */
  rules?: PricingRules;
}

export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportError";
  }
}
