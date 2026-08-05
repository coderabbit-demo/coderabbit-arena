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

### Utilization reports

`GET /reports/utilization?from=<iso>&to=<iso>` summarizes how heavily each
resource is booked over a window. Bookings are clipped to the window and capped
at the resource's capacity, so utilization stays in `0..1`. Passing pricing
`rules` in the request body also estimates revenue per resource.

```bash
curl -s 'localhost:3000/reports/utilization?from=2026-08-05T00:00:00Z&to=2026-08-06T00:00:00Z'

# same report as a CSV download (one row per resource plus a TOTAL row)
curl -s 'localhost:3000/reports/utilization?from=2026-08-05T00:00:00Z&to=2026-08-06T00:00:00Z&format=csv'

# or as a Markdown table, ready to paste into a PR comment
curl -s 'localhost:3000/reports/utilization?from=2026-08-05T00:00:00Z&to=2026-08-06T00:00:00Z&format=md'
```

## Design notes

- Time intervals are **half-open** `[start, end)`, so back-to-back bookings
  (one ending exactly when the next starts) do not conflict.
- Capacity controls how many concurrent confirmed bookings a resource allows.
- The store is an in-memory `Map`; swap `InMemoryStore` for a DB-backed
  implementation without changing the service layer.
