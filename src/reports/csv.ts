import { formatCents } from "../pricing/pricing";
import { formatUtilization } from "./reports";
import { UtilizationReport } from "./types";

/** Columns emitted for each resource row, in order. */
const HEADERS = [
  "resourceId",
  "resourceName",
  "bookingCount",
  "bookedMinutes",
  "capacityMinutes",
  "utilization",
  "revenue",
] as const;

/**
 * Escape a single CSV field per RFC 4180: wrap in double quotes when it
 * contains a comma, quote, or newline, and double any embedded quotes.
 */
function escapeField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toRow(fields: readonly string[]): string {
  return fields.map(escapeField).join(",");
}

/**
 * Serialize a utilization report to a CSV document: one row per resource plus
 * a trailing TOTAL row. Utilization is rendered as a percentage and revenue as
 * a currency string. Rows are terminated with CRLF per RFC 4180.
 */
export function reportToCsv(report: UtilizationReport): string {
  const rows: string[] = [toRow(HEADERS)];

  for (const r of report.resources) {
    rows.push(
      toRow([
        r.resourceId,
        r.resourceName,
        String(r.bookingCount),
        String(r.bookedMinutes),
        String(r.capacityMinutes),
        formatUtilization(r.utilization),
        formatCents(r.revenueCents),
      ]),
    );
  }

  const totalBookings = report.resources.reduce(
    (sum, r) => sum + r.bookingCount,
    0,
  );

  rows.push(
    toRow([
      "TOTAL",
      "",
      String(totalBookings),
      "",
      "",
      formatUtilization(report.averageUtilization),
      formatCents(report.totalRevenueCents),
    ]),
  );

  return rows.join("\r\n");
}
