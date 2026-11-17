import { createApp } from "./api/app";
import { RateLimiter } from "./api/rateLimit";
import { AttachmentService } from "./attachments/attachments";
import { AuditLog } from "./audit/audit";
import { ApiKeyService } from "./auth/apiKeys";
import { Actor } from "./auth/types";
import { loadConfig } from "./config";
import { seedDemoData } from "./demo/seed";
import { EventBus } from "./events/bus";
import { ImportExportService } from "./importexport/importer";
import { InviteService } from "./invites/invites";
import { NoteService } from "./notes/notes";
import { createMailer } from "./notifications/mailer";
import { NotificationService } from "./notifications/notifications";
import { BookingService } from "./services/bookingService";
import { ResourcePhotoService } from "./services/resourcePhotos";
import { SettingsService } from "./services/settings";
import { InMemoryStore } from "./store/store";
import { WebhookService } from "./webhooks/dispatcher";

const PORT = Number(process.env.PORT ?? 3000);
const config = loadConfig();

const store = new InMemoryStore();
const bus = new EventBus();

// Order matters: the audit log must subscribe before anything publishes so the
// bootstrap key issuance below is itself recorded.
const audit = new AuditLog(store, bus);
const apiKeys = new ApiKeyService(store, bus);
const webhooks = new WebhookService(store, bus);
const service = new BookingService(store, bus);
const attachments = new AttachmentService(config.attachmentsDir, store, bus, {
  maxBytes: config.maxAttachmentBytes,
});
const notes = new NoteService(store, bus);
const settings = new SettingsService();
const resourcePhotos = new ResourcePhotoService(store);
const mailer = createMailer(config.smtp);
const notifications = new NotificationService(store, bus, mailer, {
  publicBaseUrl: config.publicBaseUrl,
  onError: (err, message) => {
    // eslint-disable-next-line no-console
    console.error(`notification to ${message.to} failed: ${String(err)}`);
  },
});
const invites = new InviteService(store, apiKeys, bus, {
  secret: config.inviteSecret,
  ttlHours: config.inviteTtlHours,
});
const importer = new ImportExportService(store, bus, { exportsDir: config.exportsDir });
const rateLimiter = new RateLimiter({
  limit: config.rateLimitPerMinute,
  skip: ["/health"],
});

/**
 * Seed the initial admin key. In production set BOOKING_ADMIN_KEY to a secret
 * you manage; during local development one is generated and printed once.
 */
function bootstrapAdmin(): Actor {
  const configured = process.env.BOOKING_ADMIN_KEY;
  if (configured) {
    const key = apiKeys.seed(configured, { name: "bootstrap admin", role: "admin" });
    return { keyId: key.id, name: key.name, role: key.role };
  }
  const issued = apiKeys.issue({ name: "bootstrap admin", role: "admin" }, null);
  // eslint-disable-next-line no-console
  console.log(
    `No BOOKING_ADMIN_KEY set. Generated a one-off admin key:\n  ${issued.secret}\n` +
      "Set BOOKING_ADMIN_KEY to make it stable across restarts.",
  );
  return { keyId: issued.key.id, name: issued.key.name, role: issued.key.role };
}

const admin = bootstrapAdmin();
if (process.env.BOOKING_DEMO_DATA === "true") {
  seedDemoData(service, admin);
}

const app = createApp({
  service,
  apiKeys,
  audit,
  webhooks,
  attachments,
  notes,
  notifications,
  invites,
  importer,
  rateLimiter,
  settings,
  resourcePhotos,
  allowedOrigins: config.allowedOrigins,
  requestLogging: process.env.REQUEST_LOGGING !== "false",
});

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Booking API listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`Attachments stored in ${config.attachmentsDir}`);
});

// Periodically clean up files left behind by interrupted uploads.
setInterval(() => {
  const removed = attachments.sweepOrphans();
  if (removed > 0) {
    // eslint-disable-next-line no-console
    console.log(`Removed ${removed} orphaned attachment file(s)`);
  }
}, 15 * 60 * 1000);

async function shutdown(signal: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`${signal} received, draining webhook deliveries and notifications...`);
  server.close();
  await webhooks.drain();
  await notifications.drain();
  notifications.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
