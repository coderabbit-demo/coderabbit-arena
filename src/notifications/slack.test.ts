import { describe, expect, it, vi } from "vitest";
import { Booking, Resource } from "../domain/types";
import { EventBus } from "../events/bus";
import { FetchLike, SlackError, SlackNotifier } from "./slack";

const resource = { id: "r1", name: "Atlas (4th floor)", capacity: 1 } as Resource;
const store = { getResource: (id: string) => (id === "r1" ? resource : undefined) };

function booking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: "b1",
    resourceId: "r1",
    bookedBy: "Ada Lovelace",
    start: "2026-11-18T09:00:00.000Z",
    end: "2026-11-18T10:30:00.000Z",
    status: "confirmed",
    private: false,
    createdAt: "2026-11-17T12:00:00.000Z",
    createdBy: "k1",
    ...overrides,
  } as Booking;
}

function okFetch() {
  return vi.fn<Parameters<FetchLike>, ReturnType<FetchLike>>(async () => ({
    ok: true,
    status: 200,
    text: async () => "ok",
  }));
}

describe("SlackNotifier", () => {
  it("describes a booking with who, where and when", () => {
    const slack = new SlackNotifier(store, new EventBus(), { webhookUrl: "https://hooks.example/x" });
    expect(slack.describe(booking())).toBe(
      ":calendar: Ada Lovelace booked Atlas (4th floor) for Wed 18 Nov, 09:00–10:30 UTC",
    );
  });

  it("hides the name of a private booking", () => {
    const slack = new SlackNotifier(store, new EventBus(), { webhookUrl: "https://hooks.example/x" });
    expect(slack.describe(booking({ private: true }))).toMatch(/^:calendar: Someone booked/);
  });

  it("posts new bookings to the webhook", async () => {
    const fetch = okFetch();
    const bus = new EventBus();
    new SlackNotifier(store, bus, { webhookUrl: "https://hooks.example/x", fetch });
    bus.publish({ type: "booking.created", booking: booking() }, null);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://hooks.example/x");
    expect(JSON.parse(init.body).text).toContain("Ada Lovelace");
  });

  it("does nothing on bookings when not configured", () => {
    const fetch = okFetch();
    const bus = new EventBus();
    const slack = new SlackNotifier(store, bus, { fetch });
    bus.publish({ type: "booking.created", booking: booking() }, null);
    expect(slack.configured).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a test message when not configured", async () => {
    const slack = new SlackNotifier(store, new EventBus(), { webhookUrl: "  " });
    await expect(slack.sendTest()).rejects.toMatchObject({ status: 503 });
  });

  it("reports a rejected message as a 502", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 404, text: async () => "no_service" }));
    const slack = new SlackNotifier(store, new EventBus(), { webhookUrl: "https://hooks.example/x", fetch });
    const error = await slack.sendTest().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SlackError);
    expect(error).toMatchObject({ status: 502, message: expect.stringContaining("no_service") });
  });
});
