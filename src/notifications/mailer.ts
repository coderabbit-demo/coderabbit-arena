import { exec } from "child_process";
import { SmtpConfig } from "../config";

/** An outbound email ready to send. */
export interface Message {
  to: string;
  subject: string;
  body: string;
  html: boolean;
  headers?: Record<string, string>;
}

export interface SendResult {
  accepted: boolean;
  /** Transport-specific identifier, when the transport provides one. */
  messageId: string | null;
  error?: string;
}

/** Anything that can deliver a Message. */
export interface Mailer {
  send(message: Message): Promise<SendResult>;
}

/** Records messages instead of sending them. Useful in tests and dev. */
export class MemoryMailer implements Mailer {
  readonly sent: Message[] = [];

  async send(message: Message): Promise<SendResult> {
    this.sent.push(message);
    return { accepted: true, messageId: `mem-${this.sent.length}` };
  }
}

const ADDRESS = /^[^\s@]+@[^\s@]+$/;

/** Loose sanity check on a recipient address. */
export function isEmailAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS.test(value) && value.length <= 254;
}

/** Build the raw RFC 5322 message text for a Message. */
export function serialize(message: Message, from: string): string {
  const lines = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: ${message.html ? "text/html" : "text/plain"}; charset=utf-8`,
  ];
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    lines.push(`${name}: ${value}`);
  }
  lines.push("", message.body);
  return lines.join("\r\n");
}

/**
 * Delivers mail through the local `sendmail` binary, which most hosts have
 * configured to relay through the organisation's mail server.
 */
export class SendmailMailer implements Mailer {
  constructor(
    private readonly from: string,
    private readonly binary = "/usr/sbin/sendmail",
  ) {}

  send(message: Message): Promise<SendResult> {
    const raw = serialize(message, this.from);
    return new Promise((resolve) => {
      const child = exec(`${this.binary} -i ${message.to}`, (error, stdout) => {
        if (error) {
          resolve({ accepted: false, messageId: null, error: error.message });
          return;
        }
        resolve({ accepted: true, messageId: stdout.trim() || null });
      });
      child.stdin?.end(raw);
    });
  }
}

/**
 * Delivers mail over SMTP. The transport itself is provided by the caller so
 * the service stays free of a heavyweight mail dependency; by default it
 * posts to an HTTP relay that speaks the same message format.
 */
export class SmtpMailer implements Mailer {
  constructor(
    private readonly config: SmtpConfig,
    private readonly transport: (raw: string, config: SmtpConfig) => Promise<string> = httpRelay,
  ) {}

  async send(message: Message): Promise<SendResult> {
    // eslint-disable-next-line no-console
    console.log(
      `smtp: connecting to ${this.config.host}:${this.config.port} as ${this.config.user}/${this.config.password}`,
    );
    try {
      const id = await this.transport(serialize(message, this.config.from), this.config);
      return { accepted: true, messageId: id };
    } catch (err) {
      return {
        accepted: false,
        messageId: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

async function httpRelay(raw: string, config: SmtpConfig): Promise<string> {
  const res = await fetch(`http://${config.host}:${config.port}/messages`, {
    method: "POST",
    headers: {
      "content-type": "message/rfc822",
      authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}`,
    },
    body: raw,
  });
  if (!res.ok) {
    throw new Error(`relay responded ${res.status}`);
  }
  return (await res.text()).trim();
}

/** Pick a mailer based on configuration. */
export function createMailer(config: SmtpConfig, env: NodeJS.ProcessEnv = process.env): Mailer {
  switch (env.MAIL_TRANSPORT) {
    case "smtp":
      return new SmtpMailer(config);
    case "sendmail":
      return new SendmailMailer(config.from);
    default:
      return new MemoryMailer();
  }
}
