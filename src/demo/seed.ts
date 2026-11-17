import { Actor } from "../auth/types";
import { BookingService } from "../services/bookingService";

const DAY_MS = 24 * 60 * 60 * 1000;

/** An ISO timestamp `dayOffset` days from today (UTC) at `hour`:`minute`. */
function at(dayOffset: number, hour: number, minute = 0): string {
  const now = new Date();
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(day + dayOffset * DAY_MS + (hour * 60 + minute) * 60 * 1000).toISOString();
}

interface SeedBooking {
  bookedBy: string;
  day: number;
  from: number;
  to: number;
  private?: boolean;
  cancel?: boolean;
}

const ATLAS: SeedBooking[] = [
  { bookedBy: "Ada Lovelace", day: -4, from: 9, to: 10 },
  { bookedBy: "Grace Hopper", day: -3, from: 11, to: 12 },
  { bookedBy: "Alan Turing", day: -2, from: 14, to: 15 },
  { bookedBy: "Katherine Johnson", day: -1, from: 9, to: 11 },
  { bookedBy: "Edsger Dijkstra", day: 0, from: 8, to: 9 },
  { bookedBy: "Barbara Liskov", day: 0, from: 13, to: 14 },
  { bookedBy: "Donald Knuth", day: 1, from: 10, to: 11, cancel: true },
  { bookedBy: "Margaret Hamilton", day: 1, from: 15, to: 16 },
  { bookedBy: "Ken Thompson", day: 2, from: 9, to: 10 },
  { bookedBy: "Frances Allen", day: 2, from: 16, to: 17, private: true },
  { bookedBy: "Dennis Ritchie", day: 3, from: 11, to: 12 },
  { bookedBy: "Radia Perlman", day: 4, from: 9, to: 10 },
  { bookedBy: "John McCarthy", day: 5, from: 14, to: 15 },
  { bookedBy: "Hedy Lamarr", day: 6, from: 10, to: 12 },
];

const BIRCH: SeedBooking[] = [
  { bookedBy: "Linus Torvalds", day: -1, from: 13, to: 14 },
  { bookedBy: "Shafi Goldwasser", day: 1, from: 9, to: 10 },
  { bookedBy: "Leslie Lamport", day: 3, from: 15, to: 16 },
];

const PROJECTOR: SeedBooking[] = [
  { bookedBy: "Tim Berners-Lee", day: 0, from: 10, to: 12 },
  { bookedBy: "Vint Cerf", day: 2, from: 10, to: 11 },
];

/**
 * Fill an empty store with a few resources and bookings around today so the
 * dashboard has something to show. Enabled with BOOKING_DEMO_DATA=true.
 */
export function seedDemoData(service: BookingService, admin: Actor): void {
  const resources: Array<[string, number, SeedBooking[]]> = [
    ["Atlas (4th floor)", 1, ATLAS],
    ["Birch (2nd floor)", 1, BIRCH],
    ["Projector kit", 2, PROJECTOR],
  ];
  for (const [name, capacity, bookings] of resources) {
    const resource = service.createResource({ name, capacity }, admin);
    for (const b of bookings) {
      const booking = service.createBooking(
        {
          resourceId: resource.id,
          bookedBy: b.bookedBy,
          start: at(b.day, b.from),
          end: at(b.day, b.to),
          private: b.private ?? false,
        },
        admin,
      );
      if (b.cancel) {
        service.cancelBooking(booking.id, admin);
      }
    }
  }
}
