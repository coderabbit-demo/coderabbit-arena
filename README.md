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

| Method | Path             | Description                                  |
| ------ | ---------------- | -------------------------------------------- |
| GET    | `/health`        | Liveness check                               |
| POST   | `/resources`     | Create a bookable resource                   |
| GET    | `/resources`     | List resources                               |
| POST   | `/bookings`      | Create a booking (rejects conflicts)         |
| POST   | `/bookings/recurring` | Create a recurring booking series       |
| GET    | `/bookings`      | List bookings (`?resourceId=` to filter)     |
| DELETE | `/bookings/:id`  | Cancel a booking                             |
| GET    | `/reports/utilization` | Utilization report (`?from=&to=`, `&format=csv\|md`) |

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

### Recurring bookings

`POST /bookings/recurring` expands a recurrence rule into a series of bookings.
Every occurrence is conflict-checked before anything is persisted, so a single
clash rejects the whole series.

```bash
curl -X POST localhost:3000/bookings/recurring \
  -H 'content-type: application/json' \
  -d '{
    "resourceId":"<id>","bookedBy":"Ada",
    "start":"2026-08-03T09:00:00Z","end":"2026-08-03T10:00:00Z",
    "rule":{"frequency":"weekly","interval":1,"count":4,"weekdays":[1,3,5]}
  }'
```

## Design notes

- Time intervals are **half-open** `[start, end)`, so back-to-back bookings
  (one ending exactly when the next starts) do not conflict.
- Recurring series are **all-or-nothing**: every occurrence must be free, or the
  whole request is rejected with a conflict.
- Capacity controls how many concurrent confirmed bookings a resource allows.
- The store is an in-memory `Map`; swap `InMemoryStore` for a DB-backed
  implementation without changing the service layer.
