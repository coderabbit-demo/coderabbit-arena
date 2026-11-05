import { Booking, Resource } from "../domain/types";

/** Format an ISO timestamp as an iCalendar UTC stamp, e.g. 20260801T090000Z. */
function toIcsStamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Render a resource's bookings as an iCalendar (RFC 5545) feed that calendar
 * apps can subscribe to. Cancelled bookings are left out.
 */
export function bookingsToIcs(resource: Resource, bookings: Booking[]): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//booking-arena//resource-feed//EN",
    `X-WR-CALNAME:${resource.name}`,
  ];

  for (const booking of bookings) {
    if (booking.status === "cancelled") {
      continue;
    }
    lines.push(
      "BEGIN:VEVENT",
      `UID:${booking.id}@booking-arena`,
      `DTSTART:${toIcsStamp(booking.start)}`,
      `DTEND:${toIcsStamp(booking.end)}`,
      `SUMMARY:${resource.name} — ${booking.bookedBy}`,
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
