# Booking API

A small room & resource booking REST API written in TypeScript with Express.
Bookings are validated for time-range correctness and checked against a
resource's capacity so double-bookings are rejected.

## Stack

- TypeScript + Express (in-memory store)
- Vitest for unit tests

## Getting started

```bash
npm install
npm run dev      # start with hot reload on http://localhost:3000
npm run build    # compile to dist/
npm start        # run the compiled server
npm test         # run the test suite
```

## API

| Method | Path                            | Description                                  |
| ------ | ------------------------------- | -------------------------------------------- |
| GET    | `/health`                       | Liveness check                               |
| POST   | `/resources`                    | Create a bookable resource                   |
| GET    | `/resources`                    | List resources                               |
| GET    | `/resources/:id/availability`   | Free slots (`?start=&end=&slotMinutes=`)     |
| POST   | `/bookings`                     | Create a booking (rejects conflicts)         |
| GET    | `/bookings`                     | List bookings (`?resourceId=` to filter)     |
| PATCH  | `/bookings/:id`                 | Reschedule a booking                         |
| DELETE | `/bookings/:id`                 | Cancel a booking                             |

### Example

```bash
# create a room
curl -X POST localhost:3000/resources \
  -H 'content-type: application/json' \
  -d '{"name":"Room A","capacity":1}'

# book it
curl -X POST localhost:3000/bookings \
  -H 'content-type: application/json' \
  -d '{"resourceId":"<id>","bookedBy":"Ada","start":"2026-08-01T09:00:00Z","end":"2026-08-01T10:00:00Z"}'
```

## Design notes

- Time intervals are **half-open** `[start, end)`, so back-to-back bookings
  (one ending exactly when the next starts) do not conflict.
- Capacity controls how many concurrent confirmed bookings a resource allows.
- The store is an in-memory `Map`; swap `InMemoryStore` for a DB-backed
  implementation without changing the service layer.
