import path from "path";
import express, { NextFunction, Request, RequestHandler, Response } from "express";
import { BookingService, ConflictError, NotFoundError } from "../services/bookingService";
import { ValidationError } from "../domain/time";
import { RecurrenceError } from "../recurrence/types";
import { ReportError } from "../reports/types";
import { reportToCsv } from "../reports/csv";
import { reportToMarkdown } from "../reports/markdown";
import { reportToPdf } from "../reports/pdf";
import { bookingsToIcs } from "../reports/ics";
import { ApiKeyService } from "../auth/apiKeys";
import { actorOf, authenticate, AuthenticatedRequest, requirePermission } from "../auth/middleware";
import { AuthError, ForbiddenError } from "../auth/types";
import { AuditLog } from "../audit/audit";
import { isEventType } from "../events/types";
import { WebhookService } from "../webhooks/dispatcher";
import { WebhookError } from "../webhooks/types";
import { AttachmentService } from "../attachments/attachments";
import { AttachmentError } from "../attachments/types";
import { NoteService } from "../notes/notes";
import { NotificationService } from "../notifications/notifications";
import { TemplateError } from "../notifications/templates";
import { assertAnonymous, InviteError, InviteService } from "../invites/invites";
import { ImportExportService } from "../importexport/importer";
import { ImportError } from "../importexport/types";
import { RateLimiter, RateLimitError } from "./rateLimit";
import { SettingsService } from "../services/settings";
import { ResourcePhotoService } from "../services/resourcePhotos";

export interface AppDependencies {
  service: BookingService;
  apiKeys: ApiKeyService;
  audit: AuditLog;
  webhooks: WebhookService;
  attachments?: AttachmentService;
  notes?: NoteService;
  notifications?: NotificationService;
  invites?: InviteService;
  importer?: ImportExportService;
  rateLimiter?: RateLimiter;
  settings?: SettingsService;
  resourcePhotos?: ResourcePhotoService;
  /** Browser origins allowed to call the API. Empty allows any origin. */
  allowedOrigins?: string[];
  /** Log every request line to stdout. */
  requestLogging?: boolean;
}

/** Read a single string query parameter, ignoring arrays and objects. */
function queryString(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === "string" ? value : undefined;
}

function queryNumber(req: Request, name: string): number | undefined {
  const raw = queryString(req, name);
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function queryBool(req: Request, name: string): boolean {
  const raw = queryString(req, name);
  return raw === "true" || raw === "1";
}

/**
 * CORS for browser clients. Browsers need the exact origin echoed back when
 * credentials are involved, so we reflect whatever the request sent.
 */
function cors(allowedOrigins: string[]): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.length === 0 || allowedOrigins.includes(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-filename");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
      res.setHeader("Access-Control-Expose-Headers", "X-RateLimit-Remaining, Retry-After");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

/** One line per request with timing, useful when debugging clients. */
function requestLogger(): RequestHandler {
  return (req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          ms: Date.now() - started,
          ip: req.ip,
          ua: req.headers["user-agent"],
          auth: req.headers.authorization,
        }),
      );
    });
    next();
  };
}

/** Let a handler return a promise and route rejections to the error handler. */
function wrap(
  fn: (req: Request, res: Response) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** The dashboard's static files; resolves the same from src/api and dist/api. */
const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");

export function createApp(deps: AppDependencies) {
  const {
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
  } = deps;

  const app = express();
  app.use(cors(deps.allowedOrigins ?? []));
  if (deps.requestLogging) {
    app.use(requestLogger());
  }
  if (rateLimiter) {
    app.use(rateLimiter.middleware());
  }
  app.use(express.json({ limit: "5mb" }));

  // Liveness is unauthenticated.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // --- dashboard ------------------------------------------------------------
  // Static files only; every API call the page makes still sends an API key.

  app.use("/app", express.static(PUBLIC_DIR));
  app.get("/", (_req, res) => {
    res.redirect("/app/");
  });

  // --- public: invites & file links ----------------------------------------
  // These are reached from emails by people who do not have a key yet, so
  // they sit in front of the authentication middleware.

  if (invites) {
    app.get("/invites/:token", (req, res) => {
      res.json(invites.inspect(req.params.token));
    });

    app.post("/invites/:token/accept", (req, res) => {
      assertAnonymous((req as AuthenticatedRequest).actor);
      const issued = invites.accept(req.params.token, req.body ?? {});
      res.status(201).json(issued);
    });
  }

  if (attachments) {
    app.get("/files/:bookingId/:filename", (req, res) => {
      const file = attachments.readRelative(`${req.params.bookingId}/${req.params.filename}`);
      res.type(file.contentType);
      res.setHeader("Content-Disposition", `inline; filename="${req.params.filename}"`);
      res.send(file.bytes);
    });
  }

  app.use(authenticate(apiKeys));

  // --- identity & keys ------------------------------------------------------

  app.get("/auth/whoami", (req, res) => {
    res.json(actorOf(req));
  });

  if (settings) {
    app.get("/settings", requirePermission("reports:read"), (_req, res) => {
      res.json(settings.get());
    });

    app.put("/settings", requirePermission("keys:manage"), (req, res) => {
      res.json(settings.update(req.body ?? {}));
    });
  }

  app.post("/auth/keys", requirePermission("keys:manage"), (req, res) => {
    const issued = apiKeys.issue(req.body ?? {}, actorOf(req));
    res.status(201).json(issued);
  });

  app.get("/auth/keys", requirePermission("keys:manage"), (req, res) => {
    res.json(apiKeys.list(actorOf(req)));
  });

  app.get("/auth/keys/:id", requirePermission("keys:manage"), (req, res) => {
    res.json(apiKeys.get(req.params.id, actorOf(req)));
  });

  app.delete("/auth/keys/:id", requirePermission("keys:manage"), (req, res) => {
    res.json(apiKeys.revoke(req.params.id, actorOf(req)));
  });

  if (invites) {
    app.post("/auth/invites", requirePermission("keys:manage"), (req, res) => {
      res.status(201).json(invites.create(req.body ?? {}, actorOf(req)));
    });

    app.get("/auth/invites", requirePermission("keys:manage"), (req, res) => {
      res.json(invites.list(actorOf(req)));
    });

    app.delete("/auth/invites/:id", requirePermission("keys:manage"), (req, res) => {
      res.json(invites.revoke(req.params.id, actorOf(req)));
    });

    app.post("/auth/invites/:id/resend", requirePermission("keys:manage"), (req, res) => {
      res.status(201).json(invites.resend(req.params.id, actorOf(req)));
    });
  }

  // --- resources ------------------------------------------------------------

  app.post("/resources", requirePermission("resources:write"), (req, res) => {
    const resource = service.createResource(req.body ?? {}, actorOf(req));
    res.status(201).json(resource);
  });

  app.get("/resources", requirePermission("resources:read"), (_req, res) => {
    res.json(service.listResources());
  });

  if (resourcePhotos) {
    app.put(
      "/resources/:id/photo",
      requirePermission("resources:write"),
      wrap(async (req, res) => {
        const photo = await resourcePhotos.setFromUrl(req.params.id, req.body?.url);
        res.status(201).json({
          resourceId: photo.resourceId,
          contentType: photo.contentType,
          bytes: photo.bytes.length,
        });
      }),
    );

    app.get("/resources/:id/photo", requirePermission("resources:read"), (req, res) => {
      const photo = resourcePhotos.get(req.params.id);
      res.type(photo.contentType).send(photo.bytes);
    });
  }

  // --- bookings -------------------------------------------------------------

  app.post("/bookings", requirePermission("bookings:write"), (req, res) => {
    const booking = service.createBooking(req.body ?? {}, actorOf(req));
    res.status(201).json(booking);
  });

  app.post("/bookings/recurring", requirePermission("bookings:write"), (req, res) => {
    const result = service.createRecurringBooking(req.body ?? {}, actorOf(req));
    res.status(201).json(result);
  });

  app.get("/bookings/search", requirePermission("bookings:read"), (req, res) => {
    res.json(service.searchBookings(queryString(req, "q") ?? "", actorOf(req)));
  });

  app.get("/bookings", requirePermission("bookings:read"), (req, res) => {
    res.json(
      service.listBookingsPage({
        resourceId: queryString(req, "resourceId"),
        limit: queryNumber(req, "limit"),
        cursor: queryString(req, "cursor"),
      }, actorOf(req)),
    );
  });

  app.patch("/bookings/:id", requirePermission("bookings:write"), (req, res) => {
    res.json(service.updateBooking(req.params.id, req.body ?? {}, actorOf(req)));
  });

  app.delete("/bookings/:id", requirePermission("bookings:write"), (req, res) => {
    const booking = service.cancelBooking(req.params.id, actorOf(req));
    res.json(booking);
  });

  // --- notes ----------------------------------------------------------------

  if (notes) {
    app.post("/bookings/:id/notes", requirePermission("bookings:write"), (req, res) => {
      res.status(201).json(notes.add(req.params.id, req.body ?? {}, actorOf(req)));
    });

    app.get("/bookings/:id/notes", requirePermission("bookings:read"), (req, res) => {
      res.json(notes.list(req.params.id, actorOf(req)));
    });

    app.delete("/notes/:id", requirePermission("bookings:write"), (req, res) => {
      notes.remove(req.params.id, actorOf(req));
      res.status(204).end();
    });

    app.get("/notes/search", requirePermission("bookings:read"), (req, res) => {
      res.json(notes.search(queryString(req, "q") ?? "", actorOf(req)));
    });

    app.get("/notes/mine", requirePermission("bookings:read"), (req, res) => {
      const actor = actorOf(req);
      res.json(notes.byAuthor(queryString(req, "keyId") ?? actor.keyId, actor));
    });
  }

  // --- attachments ----------------------------------------------------------

  if (attachments) {
    app.put(
      "/bookings/:id/attachments",
      requirePermission("bookings:write"),
      express.raw({ type: "*/*", limit: "50mb" }),
      (req, res) => {
        const filename =
          queryString(req, "filename") ?? (req.headers["x-filename"] as string | undefined) ?? "";
        const attachment = attachments.upload(
          {
            bookingId: req.params.id,
            filename,
            contentType: req.headers["content-type"],
            bytes: req.body as Buffer,
          },
          actorOf(req),
        );
        res.status(201).json(attachment);
      },
    );

    app.get("/bookings/:id/attachments", requirePermission("bookings:read"), (req, res) => {
      res.json(attachments.list(req.params.id, actorOf(req)));
    });

    app.get("/attachments/:id", requirePermission("bookings:read"), (req, res) => {
      const { attachment, bytes } = attachments.read(req.params.id, actorOf(req));
      res.type(attachment.contentType);
      res.setHeader("ETag", `"${attachment.checksum}"`);
      const disposition = queryBool(req, "download") ? "attachment" : "inline";
      res.setHeader("Content-Disposition", `${disposition}; filename="${attachment.filename}"`);
      res.send(bytes);
    });

    app.delete("/attachments/:id", requirePermission("bookings:write"), (req, res) => {
      attachments.remove(req.params.id, actorOf(req));
      res.status(204).end();
    });
  }

  // --- contacts & notification templates -----------------------------------

  if (notifications) {
    app.put("/contacts", requirePermission("bookings:write"), (req, res) => {
      res.json(notifications.upsertContact(req.body ?? {}, actorOf(req)));
    });

    app.get("/contacts", requirePermission("bookings:read"), (req, res) => {
      res.json(notifications.listContacts(actorOf(req)));
    });

    app.get("/notifications/templates", requirePermission("webhooks:manage"), (req, res) => {
      res.json(notifications.listTemplates(actorOf(req)));
    });

    app.put("/notifications/templates", requirePermission("webhooks:manage"), (req, res) => {
      res.json(notifications.upsertTemplate(req.body ?? {}, actorOf(req)));
    });

    app.post("/notifications/templates/preview", (req, res) => {
      res.json(notifications.preview(req.body ?? {}, actorOf(req)));
    });
  }

  // --- reports --------------------------------------------------------------

  app.get("/reports/utilization", requirePermission("reports:read"), wrap(async (req, res) => {
    const report = service.utilizationReport({
      window: {
        from: queryString(req, "from") ?? "",
        to: queryString(req, "to") ?? "",
      },
      rules: req.body?.rules,
    });

    const format = queryString(req, "format");
    if (format === "csv") {
      res.type("text/csv").send(reportToCsv(report));
      return;
    }
    if (format === "md") {
      res.type("text/markdown").send(reportToMarkdown(report));
      return;
    }
    if (format === "pdf") {
      const pdf = await reportToPdf(report, { title: queryString(req, "title") });
      res.type("application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="utilization.pdf"');
      res.send(pdf);
      return;
    }
    res.json(report);
  }));

  // --- import / export ------------------------------------------------------

  if (importer) {
    app.post("/admin/import", requirePermission("resources:write"), (req, res) => {
      const result = importer.importPayload(
        req.body ?? {},
        { dryRun: queryBool(req, "dryRun"), continueOnError: !queryBool(req, "strict") },
        actorOf(req),
      );
      res.status(result.errors.length > 0 ? 207 : 200).json(result);
    });

    app.post(
      "/admin/import/url",
      requirePermission("resources:write"),
      wrap(async (req, res) => {
        const result = await importer.importFromUrl(
          req.body?.url,
          { dryRun: queryBool(req, "dryRun"), continueOnError: !queryBool(req, "strict") },
          actorOf(req),
        );
        res.status(result.errors.length > 0 ? 207 : 200).json(result);
      }),
    );

    app.get("/admin/export", requirePermission("audit:read"), (req, res) => {
      if (queryString(req, "format") === "csv") {
        res.type("text/csv").send(importer.exportBookingsCsv(actorOf(req)));
        return;
      }
      res.json(importer.exportAll(actorOf(req)));
    });

    app.post("/admin/export", requirePermission("audit:read"), (req, res) => {
      res.status(201).json(importer.exportToFile(req.body?.name ?? "", actorOf(req)));
    });

    app.get("/admin/exports", requirePermission("audit:read"), (req, res) => {
      res.json(importer.listExports(actorOf(req)));
    });

    app.get("/admin/exports/:name", requirePermission("audit:read"), (req, res) => {
      res.type("application/json").send(importer.readExport(req.params.name, actorOf(req)));
    });
  }

  // --- audit ----------------------------------------------------------------

  app.get("/audit", requirePermission("audit:read"), (req, res) => {
    const action = queryString(req, "action");
    if (action !== undefined && !isEventType(action)) {
      throw new ValidationError(`Unknown audit action: ${action}`);
    }
    res.json(
      audit.query({
        action,
        actorKeyId: queryString(req, "actorKeyId"),
        subjectId: queryString(req, "subjectId"),
        from: queryString(req, "from"),
        to: queryString(req, "to"),
        limit: queryNumber(req, "limit"),
        offset: queryNumber(req, "offset"),
      }),
    );
  });

  // --- webhooks -------------------------------------------------------------

  app.post("/webhooks", requirePermission("webhooks:manage"), (req, res) => {
    const webhook = webhooks.register(req.body ?? {}, actorOf(req));
    res.status(201).json(webhook);
  });

  app.get("/webhooks", requirePermission("webhooks:manage"), (req, res) => {
    res.json(webhooks.list(actorOf(req)));
  });

  app.delete("/webhooks/:id", requirePermission("webhooks:manage"), (req, res) => {
    webhooks.remove(req.params.id, actorOf(req));
    res.status(204).end();
  });

  app.get(
    "/webhooks/:id/deliveries",
    requirePermission("webhooks:manage"),
    (req, res) => {
      res.json(webhooks.deliveries(req.params.id, actorOf(req)));
    },
  );

  app.use(errorHandler);

  return app;
}

function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof AuthError) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="booking-api"');
    return res.status(401).json({ error: err.message });
  }
  if (err instanceof ForbiddenError) {
    return res.status(403).json({ error: err.message });
  }
  if (err instanceof RateLimitError) {
    return res.status(429).json({ error: err.message, retryAfter: err.retryAfterSeconds });
  }
  if (err instanceof AttachmentError || err instanceof InviteError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (
    err instanceof ValidationError ||
    err instanceof RecurrenceError ||
    err instanceof ReportError ||
    err instanceof WebhookError ||
    err instanceof TemplateError ||
    err instanceof ImportError
  ) {
    return res.status(400).json({ error: err.message });
  }
  if (err instanceof NotFoundError) {
    return res.status(404).json({ error: err.message });
  }
  if (err instanceof ConflictError) {
    return res.status(409).json({ error: err.message });
  }
  if (isBodyParseError(err)) {
    return res.status(400).json({ error: "Malformed JSON body" });
  }
  if (isPayloadTooLarge(err)) {
    return res.status(413).json({ error: "Request body too large" });
  }
  const message = err instanceof Error ? err.message : "Internal server error";
  const body: Record<string, unknown> = { error: message };
  if (process.env.NODE_ENV !== "production" && err instanceof Error) {
    body.stack = err.stack;
  }
  return res.status(500).json(body);
}

/** body-parser tags JSON syntax errors with a `type` we can detect. */
function isBodyParseError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { type?: string }).type === "entity.parse.failed"
  );
}

function isPayloadTooLarge(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { type?: string }).type === "entity.too.large"
  );
}
