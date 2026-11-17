// Room Bookings dashboard: a small client for the Booking API.
// No build step: plain DOM code served by Express at /app.
"use strict";

const KEY_STORAGE = "bookings.apiKey";

const state = {
  apiKey: null,
  actor: null,
  resources: [],
  selectedResourceId: null,
  bookings: [],
  // Column the booking list is sorted by, and which way.
  sort: { key: "start", dir: "asc" },
};

const $ = (id) => document.getElementById(id);

// --- API ---------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(method, path, body) {
  const headers = { authorization: `Bearer ${state.apiKey}` };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

function can(permission) {
  if (!state.actor) {
    return false;
  }
  const role = state.actor.role;
  if (permission === "resources:write") {
    return role === "admin";
  }
  if (permission === "bookings:write") {
    return role === "admin" || role === "member" || role === "service";
  }
  return true;
}

// --- formatting ----------------------------------------------------------------

const dateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

function formatWhen(booking) {
  const start = new Date(booking.start);
  const end = new Date(booking.end);
  return `${dateFormat.format(start)}, ${timeFormat.format(start)} – ${timeFormat.format(end)}`;
}

/** Combine a local date ("2026-11-17") and time ("09:30") into an ISO string. */
function toIso(date, time) {
  return new Date(`${date}T${time}`).toISOString();
}

function todayLocal() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// --- rendering -----------------------------------------------------------------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) {
    node.append(child);
  }
  return node;
}

function selectedResource() {
  return state.resources.find((r) => r.id === state.selectedResourceId) || null;
}

function renderSession() {
  const signedIn = Boolean(state.actor);
  $("sign-in").hidden = signedIn;
  $("dashboard").hidden = !signedIn;
  $("session").hidden = !signedIn;
  if (signedIn) {
    $("whoami").textContent = `${state.actor.name} · ${state.actor.role}`;
    $("resource-form").hidden = !can("resources:write");
  }
}

function renderResources() {
  const list = $("resource-list");
  list.replaceChildren();
  for (const resource of state.resources) {
    const button = el("button", { type: "button" }, [
      el("span", { textContent: resource.name }),
      el("span", { className: "muted", textContent: `×${resource.capacity}` }),
    ]);
    button.dataset.resourceId = resource.id;
    if (resource.id === state.selectedResourceId) {
      button.setAttribute("aria-current", "true");
    }
    button.addEventListener("click", () => selectResource(resource.id));
    list.append(el("li", {}, [button]));
  }
  $("no-resources").hidden = state.resources.length > 0;
}

const SORT_VALUES = {
  bookedBy: (booking) => booking.bookedBy.toLocaleLowerCase(),
  start: (booking) => new Date(booking.start).getTime(),
  status: (booking) => booking.status,
};

function compareBookings(a, b) {
  const value = SORT_VALUES[state.sort.key];
  const x = value(a);
  const y = value(b);
  return state.sort.dir === "asc" ? x > y : y > x;
}

function sortedBookings() {
  return [...state.bookings].sort(compareBookings);
}

function renderSortHeaders() {
  for (const button of document.querySelectorAll("[data-sort]")) {
    const th = button.closest("th");
    const active = button.dataset.sort === state.sort.key;
    th.setAttribute(
      "aria-sort",
      active ? (state.sort.dir === "asc" ? "ascending" : "descending") : "none",
    );
    button.querySelector(".sort-arrow").textContent = active
      ? state.sort.dir === "asc"
        ? "▲"
        : "▼"
      : "";
  }
}

function setSort(key) {
  if (state.sort.key === key) {
    state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
  } else {
    state.sort = { key, dir: "asc" };
  }
  renderBookings();
}

function renderBookings() {
  const resource = selectedResource();
  $("pick-resource").hidden = Boolean(resource);
  $("bookings-title").textContent = resource ? resource.name : "Bookings";
  $("resource-capacity-label").textContent = resource
    ? `Capacity ${resource.capacity}`
    : "";
  $("booking-form").hidden = !resource || !can("bookings:write");

  const rows = $("booking-rows");
  rows.replaceChildren();
  if (!resource) {
    $("booking-table").hidden = true;
    $("no-bookings").hidden = true;
    return;
  }

  renderSortHeaders();
  for (const booking of sortedBookings()) {
    const who = el("td", {}, [el("span", { textContent: booking.bookedBy })]);
    if (booking.private) {
      who.append(el("span", { className: "private-tag", textContent: "private" }));
    }
    const status = el("td", {}, [
      el("span", { className: `status ${booking.status}`, textContent: booking.status }),
    ]);
    const actions = el("td");
    if (booking.status === "confirmed" && can("bookings:write")) {
      const cancel = el("button", { type: "button", className: "danger", textContent: "Cancel" });
      cancel.addEventListener("click", () => cancelBooking(booking.id));
      actions.append(cancel);
    }
    const row = el("tr", {}, [who, el("td", { textContent: formatWhen(booking) }), status, actions]);
    row.dataset.bookingId = booking.id;
    rows.append(row);
  }
  $("booking-table").hidden = state.bookings.length === 0;
  $("no-bookings").hidden = state.bookings.length > 0;
}

// --- actions -------------------------------------------------------------------

async function loadResources() {
  state.resources = await api("GET", "/resources");
  if (!selectedResource() && state.resources.length > 0) {
    state.selectedResourceId = state.resources[0].id;
  }
  renderResources();
}

async function loadBookings() {
  if (!state.selectedResourceId) {
    state.bookings = [];
    renderBookings();
    return;
  }
  const params = new URLSearchParams({ resourceId: state.selectedResourceId, limit: "200" });
  const page = await api("GET", `/bookings?${params}`);
  state.bookings = page.data;
  renderBookings();
}

async function selectResource(id) {
  state.selectedResourceId = id;
  renderResources();
  await loadBookings();
}

async function signIn(apiKey) {
  state.apiKey = apiKey;
  try {
    state.actor = await api("GET", "/auth/whoami");
  } catch (err) {
    state.apiKey = null;
    state.actor = null;
    throw err;
  }
  try {
    sessionStorage.setItem(KEY_STORAGE, apiKey);
  } catch {
    // Storage can be unavailable (private mode); stay signed in for this page.
  }
  renderSession();
  await loadResources();
  await loadBookings();
}

function signOut() {
  try {
    sessionStorage.removeItem(KEY_STORAGE);
  } catch {
    // ignore
  }
  state.apiKey = null;
  state.actor = null;
  state.resources = [];
  state.bookings = [];
  state.selectedResourceId = null;
  renderSession();
}

async function cancelBooking(id) {
  try {
    await api("DELETE", `/bookings/${encodeURIComponent(id)}`);
    await loadBookings();
  } catch (err) {
    $("booking-error").textContent = err.message;
  }
}

// --- wiring --------------------------------------------------------------------

$("sign-in-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("sign-in-error").textContent = "";
  try {
    await signIn($("api-key").value.trim());
    $("sign-in-form").reset();
  } catch (err) {
    $("sign-in-error").textContent =
      err.status === 401 ? "That API key was not accepted." : err.message;
  }
});

$("sign-out").addEventListener("click", signOut);

for (const button of document.querySelectorAll("[data-sort]")) {
  button.addEventListener("click", () => setSort(button.dataset.sort));
}

$("resource-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("resource-error").textContent = "";
  try {
    const resource = await api("POST", "/resources", {
      name: $("resource-name").value.trim(),
      capacity: Number($("resource-capacity").value),
    });
    $("resource-form").reset();
    state.selectedResourceId = resource.id;
    await loadResources();
    await loadBookings();
  } catch (err) {
    $("resource-error").textContent = err.message;
  }
});

$("booking-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("booking-error").textContent = "";
  const date = $("booking-date").value;
  try {
    await api("POST", "/bookings", {
      resourceId: state.selectedResourceId,
      bookedBy: $("booked-by").value.trim(),
      start: toIso(date, $("booking-start").value),
      end: toIso(date, $("booking-end").value),
      private: $("booking-private").checked,
    });
    $("booking-form").reset();
    $("booking-date").value = todayLocal();
    await loadBookings();
  } catch (err) {
    $("booking-error").textContent = err.message;
  }
});

async function boot() {
  $("booking-date").value = todayLocal();
  let saved = null;
  try {
    saved = sessionStorage.getItem(KEY_STORAGE);
  } catch {
    saved = null;
  }
  if (saved) {
    try {
      await signIn(saved);
      return;
    } catch {
      signOut();
      return;
    }
  }
  renderSession();
}

boot();
