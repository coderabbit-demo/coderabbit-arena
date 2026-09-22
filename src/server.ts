import { createApp } from "./api/app";
import { AuditLog } from "./audit/audit";
import { ApiKeyService } from "./auth/apiKeys";
import { EventBus } from "./events/bus";
import { BookingService } from "./services/bookingService";
import { InMemoryStore } from "./store/store";
import { WebhookService } from "./webhooks/dispatcher";

const PORT = Number(process.env.PORT ?? 3000);

const store = new InMemoryStore();
const bus = new EventBus();

// Order matters: the audit log must subscribe before anything publishes so the
// bootstrap key issuance below is itself recorded.
const audit = new AuditLog(store, bus);
const apiKeys = new ApiKeyService(store, bus);
const webhooks = new WebhookService(store, bus);
const service = new BookingService(store, bus);

/**
 * Seed the initial admin key. In production set BOOKING_ADMIN_KEY to a secret
 * you manage; during local development one is generated and printed once.
 */
function bootstrapAdmin(): void {
  const configured = process.env.BOOKING_ADMIN_KEY;
  if (configured) {
    apiKeys.seed(configured, { name: "bootstrap admin", role: "admin" });
    return;
  }
  const issued = apiKeys.issue({ name: "bootstrap admin", role: "admin" }, null);
  // eslint-disable-next-line no-console
  console.log(
    `No BOOKING_ADMIN_KEY set. Generated a one-off admin key:\n  ${issued.secret}\n` +
      "Set BOOKING_ADMIN_KEY to make it stable across restarts.",
  );
}

bootstrapAdmin();

const app = createApp({ service, apiKeys, audit, webhooks });

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Booking API listening on http://localhost:${PORT}`);
});

async function shutdown(signal: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`${signal} received, draining webhook deliveries...`);
  server.close();
  await webhooks.drain();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
