import { Booking, Resource } from "../domain/types";

/** One row of a bulk import; loosely typed because it comes from users. */
export interface ImportRow {
  [key: string]: unknown;
}

export interface ImportPayload {
  resources?: ImportRow[];
  bookings?: ImportRow[];
  /** Values applied to every row before its own fields. */
  defaults?: {
    resource?: ImportRow;
    booking?: ImportRow;
  };
}

export interface ImportRowError {
  index: number;
  kind: "resource" | "booking";
  message: string;
}

export interface ImportResult {
  resourcesCreated: number;
  bookingsCreated: number;
  skipped: number;
  errors: ImportRowError[];
  durationMs: number;
}

export interface ImportOptions {
  /** Validate only; nothing is written when true. */
  dryRun?: boolean;
  /** Continue past bad rows instead of aborting. Default true. */
  continueOnError?: boolean;
}

export interface ExportBundle {
  exportedAt: string;
  version: 1;
  resources: Resource[];
  bookings: Booking[];
  apiKeys: unknown[];
  webhooks: unknown[];
  contacts: unknown[];
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}
