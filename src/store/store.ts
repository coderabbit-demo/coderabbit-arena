import { AuditEntry, AuditStore } from "../audit/audit";
import { ApiKeyStore } from "../auth/apiKeys";
import { ApiKey } from "../auth/types";
import { Booking, Resource } from "../domain/types";
import { WebhookStore } from "../webhooks/dispatcher";
import { Webhook, WebhookDelivery } from "../webhooks/types";

/** Persistence for the booking domain itself. */
export interface BookingStore {
  addResource(resource: Resource): Resource;
  getResource(id: string): Resource | undefined;
  listResources(): Resource[];
  addBooking(booking: Booking): Booking;
  getBooking(id: string): Booking | undefined;
  updateBooking(booking: Booking): Booking;
  bookingsForResource(resourceId: string, confirmedOnly?: boolean): Booking[];
  listBookings(): Booking[];
}

/**
 * Everything the application persists. Each feature area declares the slice
 * it needs; this is the union a real database adapter must implement.
 */
export interface Store extends BookingStore, ApiKeyStore, AuditStore, WebhookStore {}

/**
 * Simple in-memory store. Swap this out for a database-backed implementation
 * without touching the service layer.
 */
export class InMemoryStore implements Store {
  private resources = new Map<string, Resource>();
  private bookings = new Map<string, Booking>();
  private apiKeys = new Map<string, ApiKey>();
  private auditEntries: AuditEntry[] = [];
  private webhooks = new Map<string, Webhook>();
  private deliveries = new Map<string, WebhookDelivery>();

  // --- resources & bookings -------------------------------------------------

  addResource(resource: Resource): Resource {
    this.resources.set(resource.id, resource);
    return resource;
  }

  getResource(id: string): Resource | undefined {
    return this.resources.get(id);
  }

  listResources(): Resource[] {
    return [...this.resources.values()];
  }

  addBooking(booking: Booking): Booking {
    this.bookings.set(booking.id, booking);
    return booking;
  }

  getBooking(id: string): Booking | undefined {
    return this.bookings.get(id);
  }

  updateBooking(booking: Booking): Booking {
    this.bookings.set(booking.id, booking);
    return booking;
  }

  /** All bookings for a resource, optionally filtered to confirmed ones. */
  bookingsForResource(resourceId: string, confirmedOnly = false): Booking[] {
    return [...this.bookings.values()].filter(
      (b) =>
        b.resourceId === resourceId &&
        (!confirmedOnly || b.status === "confirmed"),
    );
  }

  listBookings(): Booking[] {
    return [...this.bookings.values()];
  }

  // --- api keys -------------------------------------------------------------

  addApiKey(key: ApiKey): ApiKey {
    this.apiKeys.set(key.id, key);
    return key;
  }

  getApiKey(id: string): ApiKey | undefined {
    return this.apiKeys.get(id);
  }

  listApiKeys(): ApiKey[] {
    return [...this.apiKeys.values()];
  }

  updateApiKey(key: ApiKey): ApiKey {
    this.apiKeys.set(key.id, key);
    return key;
  }

  // --- audit ----------------------------------------------------------------

  addAuditEntry(entry: AuditEntry): AuditEntry {
    this.auditEntries.push(entry);
    return entry;
  }

  listAuditEntries(): AuditEntry[] {
    return [...this.auditEntries];
  }

  // --- webhooks -------------------------------------------------------------

  addWebhook(webhook: Webhook): Webhook {
    this.webhooks.set(webhook.id, webhook);
    return webhook;
  }

  getWebhook(id: string): Webhook | undefined {
    return this.webhooks.get(id);
  }

  listWebhooks(): Webhook[] {
    return [...this.webhooks.values()];
  }

  removeWebhook(id: string): boolean {
    return this.webhooks.delete(id);
  }

  addDelivery(delivery: WebhookDelivery): WebhookDelivery {
    this.deliveries.set(delivery.id, delivery);
    return delivery;
  }

  updateDelivery(delivery: WebhookDelivery): WebhookDelivery {
    this.deliveries.set(delivery.id, delivery);
    return delivery;
  }

  deliveriesForWebhook(webhookId: string): WebhookDelivery[] {
    return [...this.deliveries.values()]
      .filter((d) => d.webhookId === webhookId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
