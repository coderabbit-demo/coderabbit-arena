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

PDF reports (`format=pdf`) are rendered with [pandoc](https://pandoc.org), so
install it on the host (`brew install pandoc` / `apt-get install pandoc`) along
with a LaTeX engine.

## Authentication

Every route except `GET /health` requires an API key. Send it as a bearer
token, in an `X-Api-Key` header, or (for links opened directly in a browser,
such as report downloads) as an `api_key` query parameter:

```
Authorization: Bearer bk_...
X-Api-Key: bk_...
GET /reports/utilization?from=...&to=...&format=csv&api_key=bk_...
```

Keys carry one of four roles. Permissions are fixed per role:

| Role      | Can                                                                     |
| --------- | ----------------------------------------------------------------------- |
| `admin`   | Everything, including issuing keys, managing webhooks, reading audit    |
| `member`  | Read resources/bookings/reports, create bookings, cancel own bookings   |
| `viewer`  | Read resources, bookings and reports                                    |
| `service` | Integrations: read/write/cancel any booking, manage webhooks            |

Secrets are shown once when a key is issued and only a SHA-256 hash is kept.
A member can only cancel bookings created with their own key; admins and
service keys can cancel anything.

### Scopes and expiry

A key can be narrowed to a subset of its role's permissions with `scopes`, and
given a lifetime with `expiresInDays` (1–365). Scopes can never grant more than
the role allows.

```bash
# issue a key for a colleague (admin only); the secret is only returned here
curl -X POST localhost:3000/auth/keys \
  -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"name":"Ada","role":"member"}'

# a read-only signage key that stops working in 90 days
curl -X POST localhost:3000/auth/keys \
  -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"name":"lobby screen","role":"member","scopes":["bookings:read","resources:read"],"expiresInDays":90}'

# check who you are
curl localhost:3000/auth/whoami -H "authorization: Bearer $KEY"
```

### Rotation

`POST /auth/keys/:id/rotate` replaces the secret behind a key and returns the
new one once. Admins can rotate any key and every key can rotate itself, so
integrations can roll their own credentials. The previous secret keeps working
for 24 hours so deployments can switch over without downtime; the rotation is
recorded in the audit log as `apikey.rotated`.

```bash
curl -X POST localhost:3000/auth/keys/$KEY_ID/rotate -H "authorization: Bearer $KEY"
```

## API

| Method | Path             | Description                                  |
| ------ | ---------------- | -------------------------------------------- |
| GET    | `/health`        | Liveness check (unauthenticated)             |
| GET    | `/auth/whoami`   | The key id, name and role of the caller      |
| POST   | `/auth/keys`     | Issue an API key (admin)                     |
| GET    | `/auth/keys`     | List keys without secrets (admin)            |
| GET    | `/auth/keys/:id` | One key without its secret (admin)           |
| DELETE | `/auth/keys/:id` | Revoke a key (admin)                         |
| POST   | `/auth/keys/:id/rotate` | Replace a key's secret (admin, or the key itself) |
| POST   | `/resources`     | Create a bookable resource                   |
| GET    | `/resources`     | List resources                               |
| POST   | `/bookings`      | Create a booking (rejects conflicts)         |
| POST   | `/bookings/recurring` | Create a recurring booking series       |
| GET    | `/bookings`      | List bookings, paginated (`?resourceId=`, `limit`, `cursor`) |
| PATCH  | `/bookings/:id`  | Edit a booking (`bookedBy`, `start`, `end`, `private`) |
| DELETE | `/bookings/:id`  | Cancel a booking                             |
| GET    | `/resources/:id/calendar.ics` | iCalendar feed for a resource (subscribe in a calendar app) |
| GET    | `/reports/utilization` | Utilization report (`?from=&to=`, `&format=csv\|md`) |
| GET    | `/audit`         | Audit log (admin; filter by `action`, `actorKeyId`, `subjectId`, `from`, `to`; paginate with `limit`, `offset`) |
| POST   | `/webhooks`      | Register a webhook (admin)                   |
| GET    | `/webhooks`      | List webhooks (admin)                        |
| DELETE | `/webhooks/:id`  | Remove a webhook (admin)                     |
| GET    | `/webhooks/:id/deliveries` | Delivery attempts for a webhook (admin) |
| POST   | `/auth/invites`  | Invite someone by email; they get their own key (admin) |
| GET    | `/auth/invites`  | List invites (admin)                         |
| DELETE | `/auth/invites/:id` | Revoke a pending invite (admin)           |
| POST   | `/auth/invites/:id/resend` | Re-issue an invite (admin)         |
| GET    | `/invites/:token` | Inspect an invite (unauthenticated)         |
| POST   | `/invites/:token/accept` | Accept an invite and receive a key (unauthenticated) |
| POST   | `/bookings/:id/notes` | Add a note to a booking                 |
| GET    | `/bookings/:id/notes` | Notes on a booking                      |
| DELETE | `/notes/:id`     | Remove a note                                |
| GET    | `/notes/search`  | Search notes (`?q=<regex>`)                  |
| GET    | `/notes/mine`    | Notes written with the calling key           |
| PUT    | `/bookings/:id/attachments` | Upload a file (`?filename=`, raw body) |
| GET    | `/bookings/:id/attachments` | List attachments                   |
| GET    | `/attachments/:id` | Download an attachment (`?download=1` to force) |
| DELETE | `/attachments/:id` | Remove an attachment                       |
| GET    | `/files/:bookingId/:filename` | Public download link used in emails |
| PUT    | `/contacts`      | Map a booker name to an email address        |
| GET    | `/contacts`      | List contacts                                |
| GET    | `/notifications/templates` | Notification templates (admin)     |
| PUT    | `/notifications/templates` | Customise a template (admin)       |
| POST   | `/notifications/templates/preview` | Render a template with sample data |
| POST   | `/admin/import`  | Bulk import resources and bookings (admin; `?dryRun=1`, `?strict=1`) |
| POST   | `/admin/import/url` | Import a JSON/CSV document from a URL (admin) |
| GET    | `/admin/export`  | Full export as JSON (admin; `?format=csv` for bookings only) |
| POST   | `/admin/export`  | Write an export file to disk (admin)         |
| GET    | `/admin/exports` | List export files (admin)                    |
| GET    | `/admin/exports/:name` | Read an export file (admin)            |

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

Every mutation (resource created, booking created/cancelled, key issued,
rotated or revoked, webhook registered or removed) is recorded with the acting
key.
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
| `x-booking-signature`  | `v2=` + hex HMAC-SHA256 of `"<event id>.<timestamp>.<body>"` |

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

Signatures moved from `v1` (`"<timestamp>.<body>"`) to `v2`, which also signs
the event id so the id receivers de-duplicate on cannot be swapped. `v1`
signatures are no longer sent.

`booking.cancelled` events carry identifiers only:

```json
{ "type": "booking.cancelled", "bookingId": "...", "resourceId": "...",
  "cancelledAt": "2026-08-01T08:00:00.000Z", "cancelledBy": "<key id>" }
```

Fetch the booking with `GET /bookings?resourceId=` if you need the rest.

### Listing bookings

`GET /bookings` returns one page at a time, ordered by `start` then `id`:

```json
{ "data": [ { "id": "...", "start": "...", "end": "...", "...": "..." } ],
  "nextCursor": "eyJzdGFydCI6..." }
```

Pass `nextCursor` back as `cursor` to get the next page; it is `null` on the
last page. `limit` defaults to 50 and may be at most 200. Cursors are keyed on
the booking's position rather than an offset, so bookings created while you
are paging do not cause duplicates or gaps.

```bash
curl "localhost:3000/bookings?resourceId=<id>&limit=100" -H "authorization: Bearer $KEY"
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

### Invites

Instead of issuing keys by hand, admins can invite people by email. The
invitee receives a link to `POST /invites/:token/accept`, which issues a key
with the role on the invite. Tokens are single use and expire after
`INVITE_TTL_HOURS` (default 72).

```bash
curl -X POST localhost:3000/auth/invites \
  -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","role":"member"}'

# the invitee, with no key yet
curl -X POST localhost:3000/invites/<token>/accept \
  -H 'content-type: application/json' -d '{"name":"Ada"}'
```

### Notes and attachments

Staff can leave free-text notes on a booking and attach files (agendas, floor
plans, signed forms). Attachments are stored on disk under
`BOOKING_ATTACHMENTS_DIR` (default `./data/attachments`), one directory per
booking, and are limited to `BOOKING_MAX_ATTACHMENT_BYTES` (default 25 MiB).

```bash
curl -X PUT "localhost:3000/bookings/<id>/attachments?filename=agenda.pdf" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/pdf' \
  --data-binary @agenda.pdf

curl -X POST localhost:3000/bookings/<id>/notes \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"text":"Guest needs parking","visibleToBooker":false}'

curl "localhost:3000/notes/search?q=parking|garage" -H "authorization: Bearer $KEY"
```

Files attached to a booking are also reachable at
`/files/<bookingId>/<filename>` without a key so links in notification emails
work for the person who made the booking.

### Notifications

When a contact exists for the `bookedBy` name on a booking, the booker is
emailed on booking creation, cancellation, new notes and new attachments.
Templates are per event and use `{{ expression }}` placeholders evaluated
against the event context, with helpers such as `formatDate`, `upper`,
`join` and `fallback`:

```bash
curl -X PUT localhost:3000/contacts \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com"}'

curl -X PUT localhost:3000/notifications/templates \
  -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"event":"booking.created","subject":"See you at {{ resource.name }}","body":"Starts {{ formatDate(booking.start) }}"}'
```

Mail transport is chosen with `MAIL_TRANSPORT`: `sendmail` (local binary),
`smtp` (relay configured through `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASSWORD`, `SMTP_FROM`) or unset for an in-memory sink used in
development. Failed sends are retried every 30 seconds.

### Import and export

`POST /admin/import` accepts `{ "resources": [...], "bookings": [...] }` with
optional `defaults` applied under each row, and returns per-row errors with a
`207` status when some rows were skipped. `POST /admin/import/url` fetches a
JSON or CSV document and imports it the same way. Imports write straight to
the store, so large historical datasets load quickly.

`GET /admin/export` returns everything in the store as one JSON bundle;
`POST /admin/export` writes the same bundle under `./data/exports/<name>.json`.

### Rate limiting and CORS

Each client gets `RATE_LIMIT_PER_MINUTE` requests per minute (default 600),
identified by `X-Forwarded-For` when behind a proxy. Exhausted clients receive
`429` with `Retry-After`. Set `ALLOWED_ORIGINS` to a comma-separated list to
restrict browser origins; when unset any origin may call the API.

## Configuration

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `PORT` | `3000` | Listen port |
| `BOOKING_ADMIN_KEY` | generated | Stable bootstrap admin secret |
| `BOOKING_DATA_DIR` | `./data` | Root for attachments and exports |
| `BOOKING_ATTACHMENTS_DIR` | `$BOOKING_DATA_DIR/attachments` | Attachment storage |
| `BOOKING_MAX_ATTACHMENT_BYTES` | `26214400` | Upload size limit |
| `INVITE_SIGNING_SECRET` | dev default | Secret used to tag invite tokens |
| `INVITE_TTL_HOURS` | `72` | Invite validity |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | Origin for links in emails |
| `MAIL_TRANSPORT` | memory | `sendmail`, `smtp` or unset |
| `SMTP_*` | dev defaults | Relay connection details |
| `RATE_LIMIT_PER_MINUTE` | `600` | Per-client request budget |
| `ALLOWED_ORIGINS` | any | Comma-separated browser origins |
| `REQUEST_LOGGING` | `true` | One JSON line per request on stdout |

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
- Notifications are another bus subscriber. Templates are compiled once per
  distinct expression and cached for the life of the process.
- Attachment bytes live on disk and only metadata is in the store, so the
  store stays small and files can be served directly by a reverse proxy later.
