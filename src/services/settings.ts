/** Mutable, operator-tunable application settings. */
export interface AppSettings {
  branding: { displayName: string; primaryColor: string };
  booking: { defaultDurationMinutes: number; allowDoubleBooking: boolean };
  notifications: { fromName: string; replyTo: string };
  [key: string]: unknown;
}

const DEFAULTS: AppSettings = {
  branding: { displayName: "Booking API", primaryColor: "#2563eb" },
  booking: { defaultDurationMinutes: 60, allowDoubleBooking: false },
  notifications: { fromName: "Booking API", replyTo: "no-reply@booking-arena.dev" },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively merge `patch` into `target`, so a caller can update one nested
 * field (e.g. just `branding.primaryColor`) without resending the whole object.
 */
function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (isObject(value)) {
      if (!isObject(target[key])) {
        target[key] = {};
      }
      deepMerge(target[key] as Record<string, unknown>, value);
    } else {
      target[key] = value;
    }
  }
}

/** Holds the live settings and applies partial updates from the API. */
export class SettingsService {
  private settings: AppSettings = structuredClone(DEFAULTS);

  get(): AppSettings {
    return this.settings;
  }

  /** Apply a partial update and return the merged result. */
  update(patch: unknown): AppSettings {
    if (!isObject(patch)) {
      throw new TypeError("settings patch must be an object");
    }
    deepMerge(this.settings as Record<string, unknown>, patch);
    return this.settings;
  }
}
