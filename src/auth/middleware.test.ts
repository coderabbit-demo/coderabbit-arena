import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Server } from "http";
import { AddressInfo } from "net";
import { createApp } from "../api/app";
import { AuditLog } from "../audit/audit";
import { EventBus } from "../events/bus";
import { BookingService } from "../services/bookingService";
import { InMemoryStore } from "../store/store";
import { WebhookService } from "../webhooks/dispatcher";
import { ApiKeyService } from "./apiKeys";

describe.each(["unset", "empty"])("service authentication with %s configuration", (configuration) => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryStore;
  let viewerSecret: string;

  beforeAll(async () => {
    vi.stubEnv("CALENDAR_SYNC_TOKEN", "");
    if (configuration === "unset") {
      delete process.env.CALENDAR_SYNC_TOKEN;
    }
    store = new InMemoryStore();
    const bus = new EventBus();
    const apiKeys = new ApiKeyService(store, bus);
    viewerSecret = apiKeys.issue({ name: "viewer", role: "viewer" }, null).secret;
    const app = createApp({
      service: new BookingService(store, bus),
      apiKeys,
      audit: new AuditLog(store, bus),
      webhooks: new WebhookService(store, bus),
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
  });

  it.each([undefined, "", "calendar-sync-dev-token", "wrong-token"])(
    "rejects protected requests with service header %s",
    async (token) => {
      const headers: Record<string, string> =
        token === undefined ? {} : { "x-service-token": token };
      for (const path of ["/auth/whoami", "/bookings", "/webhooks"]) {
        const response = await fetch(`${baseUrl}${path}`, { headers });
        expect(response.status).toBe(401);
        await response.text();
      }
      const response = await fetch(`${baseUrl}/auth/keys`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "unauthorized", role: "admin" }),
      });
      expect(response.status).toBe(401);
      await response.text();
      expect(store.listApiKeys()).toHaveLength(1);
    },
  );

  it("preserves bearer authentication without granting service privileges", async () => {
    const headers = {
      authorization: `Bearer ${viewerSecret}`,
      "x-service-token": "calendar-sync-dev-token",
    };
    const identity = await fetch(`${baseUrl}/auth/whoami`, { headers });
    expect(identity.status).toBe(200);
    expect(await identity.json()).toMatchObject({ name: "viewer", role: "viewer" });

    const keys = await fetch(`${baseUrl}/auth/keys`, { headers });
    expect(keys.status).toBe(403);
    await keys.text();
  });
});
