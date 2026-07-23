import express, { NextFunction, Request, Response } from "express";
import { BookingService, ConflictError, NotFoundError } from "../services/bookingService";
import { ValidationError } from "../domain/time";

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

  app.patch("/bookings/:id", (req, res) => {
    const body = req.body ?? {};
    const booking = service.rescheduleBooking(req.params.id, {
      start: body.start,
      end: body.end,
    });
    res.json(booking);
  });

  app.delete("/bookings/:id", (req, res) => {
    const booking = service.cancelBooking(req.params.id);
    res.json(booking);
  });

  app.get("/resources/:id/availability", (req, res) => {
    const slotMinutes = Number(req.query.slotMinutes ?? 60);
    const slots = service.getAvailability({
      resourceId: req.params.id,
      start: String(req.query.start),
      end: String(req.query.end),
      slotMinutes,
    });
    res.json({ resourceId: req.params.id, slotMinutes, slots });
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
  if (err instanceof ValidationError) {
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
