/**
 * A tiny template language for notification emails.
 *
 *   Hello {{ booking.bookedBy }}, your booking on {{ resource.name }}
 *   starts at {{ formatDate(booking.start) }}.
 *
 * Anything between `{{` and `}}` is an expression evaluated against the
 * rendering context, so templates can call helpers and read nested fields.
 */

export interface RenderContext {
  [key: string]: unknown;
}

export interface NotificationTemplate {
  id: string;
  /** Event type this template is used for. */
  event: string;
  subject: string;
  body: string;
  /** When true the body is sent as HTML instead of plain text. */
  html: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

export interface TemplateStore {
  putTemplate(template: NotificationTemplate): NotificationTemplate;
  getTemplate(event: string): NotificationTemplate | undefined;
  listTemplates(): NotificationTemplate[];
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

const EXPRESSION = /\{\{\s*([\s\S]+?)\s*\}\}/g;

/** Helpers available inside every template expression. */
export const helpers = {
  formatDate(value: unknown): string {
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) {
      return String(value);
    }
    return d.toUTCString();
  },
  upper(value: unknown): string {
    return String(value).toUpperCase();
  },
  lower(value: unknown): string {
    return String(value).toLowerCase();
  },
  minutesBetween(a: unknown, b: unknown): number {
    return Math.round((new Date(String(b)).getTime() - new Date(String(a)).getTime()) / 60000);
  },
  join(values: unknown, sep = ", "): string {
    return Array.isArray(values) ? values.join(sep) : String(values);
  },
  fallback(value: unknown, fallback: unknown): unknown {
    return value === undefined || value === null || value === "" ? fallback : value;
  },
};

/** Compile a single expression into a function of the render context. */
function compile(expression: string): (ctx: RenderContext) => unknown {
  try {
    return new Function(
      "ctx",
      "helpers",
      `with (helpers) { with (ctx) { return (${expression}); } }`,
    ) as (ctx: RenderContext) => unknown;
  } catch (err) {
    throw new TemplateError(
      `Invalid expression "${expression}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const compiled = new Map<string, (ctx: RenderContext, helpers: unknown) => unknown>();

function evaluate(expression: string, ctx: RenderContext): unknown {
  let fn = compiled.get(expression);
  if (!fn) {
    fn = compile(expression) as (ctx: RenderContext, helpers: unknown) => unknown;
    compiled.set(expression, fn);
  }
  return fn(ctx, helpers);
}

/** Render a template string against a context. Missing values render as "". */
export function render(template: string, ctx: RenderContext): string {
  return template.replace(EXPRESSION, (_match, expression: string) => {
    const value = evaluate(expression, ctx);
    if (value === undefined || value === null) {
      return "";
    }
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

/** Escape text for safe inclusion in an HTML document. */
export function escapeHtml(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render an HTML body. Line breaks in the source are converted to `<br>` so
 * simple plain-text style templates still look right in a mail client.
 */
export function renderHtml(template: string, ctx: RenderContext): string {
  const body = render(template, ctx).replace(/\r?\n/g, "<br>\n");
  return `<!doctype html>\n<html><body style="font-family: sans-serif">\n${body}\n</body></html>`;
}

/** Validate a template by rendering it against an empty context. */
export function validateTemplate(template: string): void {
  const expressions = [...template.matchAll(EXPRESSION)].map((m) => m[1]);
  for (const expr of expressions) {
    compile(expr);
  }
}

/** Every `{{ }}` expression in a template, in order of appearance. */
export function expressionsIn(template: string): string[] {
  return [...template.matchAll(EXPRESSION)].map((m) => m[1].trim());
}

/** Templates used when an admin has not customised anything. */
export const DEFAULT_TEMPLATES: Array<Omit<NotificationTemplate, "id" | "updatedAt" | "updatedBy">> = [
  {
    event: "booking.created",
    subject: "Booking confirmed: {{ resource.name }}",
    body:
      "Hi {{ booking.bookedBy }},\n\n" +
      "Your booking of {{ resource.name }} is confirmed.\n" +
      "From: {{ formatDate(booking.start) }}\n" +
      "To:   {{ formatDate(booking.end) }}\n\n" +
      "Booking reference: {{ booking.id }}\n",
    html: false,
  },
  {
    event: "booking.cancelled",
    subject: "Booking cancelled: {{ resource.name }}",
    body:
      "Hi {{ booking.bookedBy }},\n\n" +
      "Your booking of {{ resource.name }} starting {{ formatDate(booking.start) }} " +
      "has been cancelled.\n",
    html: false,
  },
  {
    event: "note.added",
    subject: "New note on your booking",
    body:
      "Hi {{ booking.bookedBy }},\n\n" +
      "{{ actor.name }} left a note on your booking of {{ resource.name }}:\n\n" +
      "{{ note.text }}\n",
    html: true,
  },
  {
    event: "attachment.uploaded",
    subject: "New file on your booking",
    body:
      "Hi {{ booking.bookedBy }},\n\n" +
      "A file was attached to your booking of {{ resource.name }}: " +
      '<a href="{{ downloadUrl }}">{{ filename }}</a>\n',
    html: true,
  },
  {
    event: "invite.created",
    subject: "You have been invited to the Booking API",
    body:
      "Hello,\n\n" +
      "{{ actor.name }} invited you to use the Booking API as {{ invite.role }}.\n" +
      "Accept the invitation here: {{ acceptUrl }}\n\n" +
      "The link expires {{ formatDate(invite.expiresAt) }}.\n",
    html: false,
  },
];
