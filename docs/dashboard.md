# Dashboard guide

The dashboard at `/app/` is a small client for the Booking API. It is plain
HTML, CSS and JavaScript with no build step and no dependencies, so you can
edit a file in `public/` and reload the page to see the change.

## Files

| File | What it holds |
| ---- | ------------- |
| `public/index.html` | The markup for every panel: the sign-in card, the session bar, the resource sidebar, the bookings table and the forms. Panels start `hidden` and the script shows the ones that apply. |
| `public/styles.css` | All styles. Colours, the border radius and the font are CSS custom properties on `:root`. |
| `public/app.js` | State, API calls, rendering and event wiring, in that order. |

Express serves the folder with `express.static` at `/app`, in front of the
authentication middleware, so the page itself needs no key. Every API call the
page makes sends one.

## How the script is organised

`app.js` keeps everything the page shows in one `state` object:

| Field | Meaning |
| ----- | ------- |
| `apiKey` | The key the user signed in with. It is also kept in `sessionStorage` under `bookings.apiKey`, so it lasts for the browser tab and no longer. |
| `actor` | The result of `GET /auth/whoami`: name and role. |
| `resources` | The result of `GET /resources`. |
| `selectedResourceId` | The resource whose bookings are shown. |
| `bookings` | The selected resource's bookings, from `GET /bookings?resourceId=…`. |

The flow is the same everywhere: an action calls the API, updates `state`,
and calls a `render…` function. Render functions rebuild their part of the
page from `state` and never read the DOM to decide what to show.

| Function | Renders |
| -------- | ------- |
| `renderSession()` | Which top-level panels are visible, and the "name · role" label. |
| `renderResources()` | The resource list, with the selected one marked `aria-current`. |
| `renderBookings()` | The bookings header, table and the new-booking form. |

DOM nodes are built with the small `el(tag, props, children)` helper and
`textContent`, never `innerHTML`, so names from the API can't inject markup.

## Roles

`can(permission)` mirrors the server's role table closely enough to decide
what to show. It is only a hint for the interface: the server still checks
every request.

| Role | Sees |
| ---- | ---- |
| `admin` | Everything, including the "Add resource" form. |
| `member`, `service` | Bookings, the new-booking form and "Cancel". |
| `viewer` | Bookings only. |

## Times

The form's date and time inputs are in the browser's time zone. `toIso()`
turns them into UTC ISO strings for the API, and `formatWhen()` turns the
API's timestamps back into local dates and times with `Intl.DateTimeFormat`.
The demo seed (`src/demo/seed.ts`) places bookings at whole hours in UTC, so
they show at different local times depending on where you are.

## Adding a panel

1. Add the markup to `index.html` with the `hidden` attribute.
2. Add any new data to `state`, and load it in an `async load…()` function
   that calls `api()`.
3. Write a `render…()` function that reads only `state`, and call it after
   the load.
4. Wire events at the bottom of `app.js`, next to the existing listeners.
5. If an element sets `display` in CSS, check that `hidden` still hides it:
   an author `display` rule overrides the attribute.

## Trying it out

```bash
BOOKING_DEMO_DATA=true BOOKING_ADMIN_KEY=bk_change_me_to_something_long npm run dev
```

Open [http://localhost:3000/app/](http://localhost:3000/app/) and sign in with
the `BOOKING_ADMIN_KEY` value. To see the page as another role, issue a key
with `POST /auth/keys` (see [Authentication](../README.md#authentication)) and
sign in with that.
