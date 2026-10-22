import express, { NextFunction, Request, Response } from "express";
import { BookingService, ConflictError, NotFoundError } from "../services/bookingService";
import { ValidationError } from "../domain/time";
import { RecurrenceError } from "../recurrence/types";
import { ReportError } from "../reports/types";
import { reportToCsv } from "../reports/csv";
import { reportToMarkdown } from "../reports/markdown";
import { ApiKeyService } from "../auth/apiKeys";
import { actorOf, authenticate, requirePermission } from "../auth/middleware";
import { AuthError, ForbiddenError } from "../auth/types";
import { AuditLog } from "../audit/audit";
import { isEventType } from "../events/types";
import { WebhookService } from "../webhooks/dispatcher";
import { WebhookError } from "../webhooks/types";

export interface AppDependencies {
  service: BookingService;
  apiKeys: ApiKeyService;
  audit: AuditLog;
  webhooks: WebhookService;
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

export function createApp({ service, apiKeys, audit, webhooks }: AppDependencies) {
  const app = express();
  app.use(express.json());

  // Liveness is the only unauthenticated route.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(authenticate(apiKeys));

  // --- identity & keys ------------------------------------------------------

  app.get("/auth/whoami", (req, res) => {
    res.json(actorOf(req));
  });

  app.post("/auth/keys", requirePermission("keys:manage"), (req, res) => {
    const issued = apiKeys.issue(req.body ?? {}, actorOf(req));
    res.status(201).json(issued);
  });

  app.get("/auth/keys", requirePermission("keys:manage"), (req, res) => {
    res.json(apiKeys.list(actorOf(req)));
  });

  app.delete("/auth/keys/:id", requirePermission("keys:manage"), (req, res) => {
    res.json(apiKeys.revoke(req.params.id, actorOf(req)));
  });

  // --- resources ------------------------------------------------------------

  app.post("/resources", requirePermission("resources:write"), (req, res) => {
    const resource = service.createResource(req.body ?? {}, actorOf(req));
    res.status(201).json(resource);
  });

  app.get("/resources", requirePermission("resources:read"), (_req, res) => {
    res.json(service.listResources());
  });

  // --- bookings -------------------------------------------------------------

  app.post("/bookings", requirePermission("bookings:write"), (req, res) => {
    const booking = service.createBooking(req.body ?? {}, actorOf(req));
    res.status(201).json(booking);
  });

  app.post("/bookings/recurring", requirePermission("bookings:write"), (req, res) => {
    const result = service.createRecurringBooking(req.body ?? {}, actorOf(req));
    res.status(201).json(result);
  });

  app.get("/bookings", requirePermission("bookings:read"), (req, res) => {
    res.json(
      service.listBookingsPage({
        resourceId: queryString(req, "resourceId"),
        limit: queryNumber(req, "limit"),
        cursor: queryString(req, "cursor"),
      }),
    );
  });

  app.delete("/bookings/:id", requirePermission("bookings:write"), (req, res) => {
    const booking = service.cancelBooking(req.params.id, actorOf(req));
    res.json(booking);
  });

  // --- reports --------------------------------------------------------------

  app.get("/reports/utilization", requirePermission("reports:read"), (req, res) => {
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
    res.json(report);
  });

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
  if (
    err instanceof ValidationError ||
    err instanceof RecurrenceError ||
    err instanceof ReportError ||
    err instanceof WebhookError
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
  const message = err instanceof Error ? err.message : "Internal server error";
  return res.status(500).json({ error: message });
}

/** body-parser tags JSON syntax errors with a `type` we can detect. */
function isBodyParseError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { type?: string }).type === "entity.parse.failed"
  );
}
