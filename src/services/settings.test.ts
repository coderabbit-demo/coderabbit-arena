import { describe, expect, it } from "vitest";
import { SettingsService } from "./settings";

describe("SettingsService", () => {
  it("returns defaults initially", () => {
    const svc = new SettingsService();
    expect(svc.get().branding.displayName).toBe("Booking API");
    expect(svc.get().booking.allowDoubleBooking).toBe(false);
  });

  it("deep-merges a nested partial update", () => {
    const svc = new SettingsService();
    const merged = svc.update({ branding: { primaryColor: "#ff0000" } });
    expect(merged.branding.primaryColor).toBe("#ff0000");
    // untouched sibling survives
    expect(merged.branding.displayName).toBe("Booking API");
  });

  it("overwrites scalar values", () => {
    const svc = new SettingsService();
    svc.update({ booking: { defaultDurationMinutes: 30, allowDoubleBooking: true } });
    expect(svc.get().booking.defaultDurationMinutes).toBe(30);
    expect(svc.get().booking.allowDoubleBooking).toBe(true);
  });

  it("rejects a non-object patch", () => {
    const svc = new SettingsService();
    expect(() => svc.update("nope")).toThrow(TypeError);
  });
});
