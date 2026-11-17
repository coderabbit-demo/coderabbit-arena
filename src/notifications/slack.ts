import { Booking } from "../domain/types";
import { EventBus } from "../events/bus";
import { BookingStore } from "../store/store";

/** Raised when Slack is not configured or rejects a message. */
export class SlackError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SlackError";
  }
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface SlackOptions {
  /** Incoming webhook URL for the channel, from SLACK_WEBHOOK_URL. */
  webhookUrl?: string;
  fetch?: FetchLike;
  onError?: (error: unknown) => void;
}

const timeFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

/**
 * Posts a message to a Slack channel whenever someone makes a booking.
 * Private bookings are announced without the booker's name.
 */
export class SlackNotifier {
  private readonly webhookUrl: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly onError: (error: unknown) => void;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly store: Pick<BookingStore, "getResource">,
    bus: EventBus,
    options: SlackOptions = {},
  ) {
    this.webhookUrl = options.webhookUrl?.trim() || undefined;
    this.fetchImpl = options.fetch ?? (fetch as unknown as FetchLike);
    this.onError = options.onError ?? (() => undefined);
    this.unsubscribe = bus.subscribe("booking.created", (envelope) => {
      if (!this.configured || envelope.event.type !== "booking.created") {
        return;
      }
      this.send(this.describe(envelope.event.booking)).catch(this.onError);
    });
  }

  get configured(): boolean {
    return this.webhookUrl !== undefined;
  }

  /** Text announced in the channel for a new booking. */
  describe(booking: Booking): string {
    const resource = this.store.getResource(booking.resourceId);
    const who = booking.private ? "Someone" : booking.bookedBy;
    const where = resource ? resource.name : "a resource";
    const start = timeFormat.format(new Date(booking.start));
    const end = timeFormat.format(new Date(booking.end)).split(", ").pop();
    return `:calendar: ${who} booked ${where} for ${start}–${end} UTC`;
  }

  async sendTest(): Promise<void> {
    await this.send(":wave: Test message from the Booking API. Booking alerts will appear here.");
  }

  async send(text: string): Promise<void> {
    if (!this.webhookUrl) {
      throw new SlackError("Slack is not configured. Set SLACK_WEBHOOK_URL and restart.", 503);
    }
    const res = await this.fetchImpl(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      throw new SlackError(`Slack rejected the message (${res.status}): ${detail}`, 502);
    }
  }

  close(): void {
    this.unsubscribe();
  }
}
