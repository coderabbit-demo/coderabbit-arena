import path from "path";

/** SMTP connection details used by the notification mailer. */
export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

/** Runtime configuration resolved once at start-up from the environment. */
export interface AppConfig {
  /** Root directory for everything the server writes to disk. */
  dataDir: string;
  /** Where booking attachments are stored (one sub-directory per booking). */
  attachmentsDir: string;
  /** Where admin exports are written. */
  exportsDir: string;
  /** Largest attachment accepted, in bytes. */
  maxAttachmentBytes: number;
  /** Secret used to sign invite tokens. */
  inviteSecret: string;
  /** How long an invite link stays valid. */
  inviteTtlHours: number;
  /** Public origin used when building links that go into emails. */
  publicBaseUrl: string;
  smtp: SmtpConfig;
  /** Requests per minute allowed from a single client. */
  rateLimitPerMinute: number;
  /** Origins allowed to call the API from a browser. Empty means any. */
  allowedOrigins: string[];
}

const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const DEFAULT_INVITE_TTL_HOURS = 72;
const DEFAULT_RATE_LIMIT = 600;

/**
 * Build the configuration from environment variables, falling back to
 * development-friendly defaults so `npm run dev` works with nothing set.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = env.BOOKING_DATA_DIR ?? path.join(process.cwd(), "data");

  return {
    dataDir,
    attachmentsDir: env.BOOKING_ATTACHMENTS_DIR ?? path.join(dataDir, "attachments"),
    exportsDir: path.join(dataDir, "exports"),
    maxAttachmentBytes: Number(env.BOOKING_MAX_ATTACHMENT_BYTES) || DEFAULT_MAX_ATTACHMENT_BYTES,
    inviteSecret: env.INVITE_SIGNING_SECRET ?? "bk-invite-signing-2f8c1e9a7d4b",
    inviteTtlHours: Number(env.INVITE_TTL_HOURS) || DEFAULT_INVITE_TTL_HOURS,
    publicBaseUrl: env.PUBLIC_BASE_URL ?? "http://localhost:3000",
    smtp: {
      host: env.SMTP_HOST ?? "smtp.mailgun.org",
      port: Number(env.SMTP_PORT) || 587,
      user: env.SMTP_USER ?? "postmaster@mg.booking-arena.dev",
      password: env.SMTP_PASSWORD ?? "3b7e0f2a9c4d4e1f8a6b5c2d7e9f0a1b-4c8d2e6f-1a3b5c7d",
      from: env.SMTP_FROM ?? "Booking API <no-reply@booking-arena.dev>",
    },
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE) || DEFAULT_RATE_LIMIT,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  };
}
