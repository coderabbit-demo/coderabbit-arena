import express, { NextFunction, Request, Response } from "express";
import { BookingService, ConflictError, NotFoundError } from "../services/bookingService";
import { ValidationError } from "../domain/time";
import { ReportError } from "../reports/types";

export function createApp(service: BookingService) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/resources", (req, res) => {
    const resource = service.createResource(req.body ?? {});
    res.status(201).json(resource);
  });

  app.get("/resources", (_req, res) => {
    res.json(service.listResources());
  });

  app.post("/bookings", (req, res) => {
    const booking = service.createBooking(req.body ?? {});
    res.status(201).json(booking);
  });

  app.get("/bookings", (req, res) => {
    const resourceId =
      typeof req.query.resourceId === "string" ? req.query.resourceId : undefined;
    res.json(service.listBookings(resourceId));
  });

  app.delete("/bookings/:id", (req, res) => {
    const booking = service.cancelBooking(req.params.id);
    res.json(booking);
  });

  app.get("/reports/utilization", (req, res) => {
    const from = typeof req.query.from === "string" ? req.query.from : "";
    const to = typeof req.query.to === "string" ? req.query.to : "";
    const report = service.utilizationReport({
      window: { from, to },
      rules: req.body?.rules,
    });
    res.json(report);
  });

  app.use(errorHandler);

  return app;
}

function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof ValidationError || err instanceof ReportError) {
    return res.status(400).json({ error: err.message });
  }
  if (err instanceof NotFoundError) {
    return res.status(404).json({ error: err.message });
  }
  if (err instanceof ConflictError) {
    return res.status(409).json({ error: err.message });
  }
  const message = err instanceof Error ? err.message : "Internal server error";
  return res.status(500).json({ error: message });
}
