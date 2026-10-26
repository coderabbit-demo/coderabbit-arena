# Booking API

A small room & resource booking REST API written in TypeScript with Express.
Bookings are validated for time-range correctness and checked against a
resource's capacity so double-bookings are rejected. Every request is
authenticated with an API key, every mutation is written to an audit log, and
changes can be pushed to external systems through signed webhooks.

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

On first start the server prints a one-off admin key. Set `BOOKING_ADMIN_KEY`
(any string starting with `bk_`, at least 24 characters) to make the bootstrap
admin key stable across restarts:

```bash
BOOKING_ADMIN_KEY=bk_change_me_to_something_long npm run dev
```

## Authentication

Every route except `GET /health` requires a bearer token:

```
Authorization: Bearer bk_...
```

Keys carry one of three roles. Permissions are fixed per role:

| Role     | Can                                                                   |
| -------- | --------------------------------------------------------------------- |
| `admin`  | Everything, including issuing keys, managing webhooks, reading audit  |
| `member` | Read resources/bookings/reports, create bookings, cancel own bookings |
| `viewer` | Read resources, bookings and reports                                  |

Secrets are shown once when a key is issued and only a SHA-256 hash is kept.
A member can only cancel bookings created with their own key; admins can cancel
anything.

```bash
# issue a key for a colleague (admin only); the secret is only returned here
curl -X POST localhost:3000/auth/keys \
  -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"name":"Ada","role":"member"}'

# check who you are
curl localhost:3000/auth/whoami -H "authorization: Bearer $KEY"
```

## API

| Method | Path             | Description                                  |
| ------ | ---------------- | -------------------------------------------- |
| GET    | `/health`        | Liveness check (unauthenticated)             |
| GET    | `/auth/whoami`   | The key id, name and role of the caller      |
| POST   | `/auth/keys`     | Issue an API key (admin)                     |
| GET    | `/auth/keys`     | List keys without secrets (admin)            |
| DELETE | `/auth/keys/:id` | Revoke a key (admin)                         |
| POST   | `/resources`     | Create a bookable resource                   |
| GET    | `/resources`     | List resources                               |
| POST   | `/bookings`      | Create a booking (rejects conflicts)         |
| POST   | `/bookings/recurring` | Create a recurring booking series       |
| GET    | `/bookings`      | List bookings (`?resourceId=` to filter); private bookings only show to their creator and admins |
| DELETE | `/bookings/:id`  | Cancel a booking                             |
| GET    | `/reports/utilization` | Utilization report (`?from=&to=`, `&format=csv\|md`) |
| GET    | `/audit`         | Audit log (admin; filter by `action`, `actorKeyId`, `subjectId`, `from`, `to`; paginate with `limit`, `offset`) |
| POST   | `/webhooks`      | Register a webhook (admin)                   |
| GET    | `/webhooks`      | List webhooks (admin)                        |
| DELETE | `/webhooks/:id`  | Remove a webhook (admin)                     |
| GET    | `/webhooks/:id/deliveries` | Delivery attempts for a webhook (admin) |

### Example

```bash
# create a room
curl -X POST localhost:3000/resources \
  -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"name":"Room A","capacity":1}'

# book it
curl -X POST localhost:3000/bookings \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"resourceId":"<id>","bookedBy":"Ada","start":"2026-08-01T09:00:00Z","end":"2026-08-01T10:00:00Z"}'
```

Pass `"private": true` to keep a booking (an interview, a 1:1) out of other
keys' listings.

### Audit log

Every mutation (resource created, booking created/cancelled, key issued or
revoked, webhook registered or removed) is recorded with the acting key.
Entries are returned newest first.

```bash
curl "localhost:3000/audit?action=booking.cancelled&limit=20" \
  -H "authorization: Bearer $ADMIN_KEY"
```

### Webhooks

Register an `http(s)` URL and optionally the event types you care about (or
`"*"` for everything). Each delivery is a `POST` of the event envelope as JSON
with three headers:

| Header                 | Meaning                                              |
| ---------------------- | ---------------------------------------------------- |
| `x-booking-event-id`   | Unique id of the event; use it to de-duplicate       |
| `x-booking-timestamp`  | Unix seconds when the delivery was signed            |
| `x-booking-signature`  | `v1=` + hex HMAC-SHA256 of `"<timestamp>.<body>"`    |

Failed deliveries (network errors, `5xx`, `408`, `429`) are retried up to three
times with exponential backoff; other `4xx` responses fail immediately. Inspect
outcomes with `GET /webhooks/:id/deliveries`.

```bash
curl -X POST localhost:3000/webhooks \
  -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"url":"https://example.com/hooks/booking","events":["booking.created","booking.cancelled"]}'
```

Receivers should verify the signature with the shared secret and reject
deliveries whose timestamp is more than five minutes old; see
`src/webhooks/signing.ts` for a reference `verifySignature`.

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
- Every mutation publishes a domain event on an in-process `EventBus`. The
  audit log and webhook dispatcher are just subscribers, so new consumers can
  be added without touching the booking service.
- Webhook payloads are HMAC-signed with a timestamp folded into the signed
  material, so a captured delivery cannot be replayed later.
- The store is an in-memory `Map`; swap `InMemoryStore` for a DB-backed
  implementation of the `Store` interface without changing the service layer.
