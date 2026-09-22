import { randomUUID } from "crypto";
import { Actor } from "../auth/types";
import {
  DomainEvent,
  EventEnvelope,
  EventHandler,
  EventPattern,
} from "./types";

export type ErrorReporter = (error: unknown, envelope: EventEnvelope) => void;

/**
 * Minimal synchronous in-process pub/sub. Handlers run inline on publish, in
 * subscription order, and a throwing handler never prevents the others from
 * running: failures are routed to `onError` instead.
 */
export class EventBus {
  private readonly handlers = new Map<EventPattern, Set<EventHandler>>();
  private readonly history: EventEnvelope[] = [];

  constructor(
    private readonly onError: ErrorReporter = defaultErrorReporter,
    private readonly clock: () => Date = () => new Date(),
    private readonly historyLimit = 1000,
  ) {}

  /** Register a handler. Returns a function that unsubscribes it again. */
  subscribe(pattern: EventPattern, handler: EventHandler): () => void {
    let set = this.handlers.get(pattern);
    if (!set) {
      set = new Set();
      this.handlers.set(pattern, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  /** Wrap an event in an envelope and fan it out to matching handlers. */
  publish<E extends DomainEvent>(event: E, actor: Actor | null): EventEnvelope<E> {
    const envelope: EventEnvelope<E> = {
      id: randomUUID(),
      occurredAt: this.clock().toISOString(),
      actor,
      event,
    };

    this.remember(envelope);

    const targets = [
      ...(this.handlers.get(event.type) ?? []),
      ...(this.handlers.get("*") ?? []),
    ];
    for (const handler of targets) {
      try {
        handler(envelope);
      } catch (err) {
        this.onError(err, envelope);
      }
    }

    return envelope;
  }

  /** Recent envelopes, oldest first, capped at `historyLimit`. */
  recent(): readonly EventEnvelope[] {
    return this.history;
  }

  /** Number of handlers currently listening for `pattern`. */
  subscriberCount(pattern: EventPattern): number {
    return this.handlers.get(pattern)?.size ?? 0;
  }

  private remember(envelope: EventEnvelope): void {
    this.history.push(envelope);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
  }
}

function defaultErrorReporter(error: unknown, envelope: EventEnvelope): void {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`event handler failed for ${envelope.event.type}: ${message}`);
}
