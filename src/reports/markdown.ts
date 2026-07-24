import { formatCents } from "../pricing/pricing";
import { formatUtilization } from "./reports";
import { UtilizationReport } from "./types";

/** Column headers for the Markdown table, in order. */
const HEADERS = [
  "Resource",
  "Bookings",
  "Booked (min)",
  "Capacity (min)",
  "Utilization",
  "Revenue",
] as const;

/** Escape the pipe and backslash characters that would break a table cell. */
function escapeCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function toRow(cells: readonly string[]): string {
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

/**
 * Render a utilization report as a GitHub-flavored Markdown table with a title
 * showing the reporting window and a trailing bold **Total** row. Handy for
 * pasting a report straight into a PR comment or Slack message.
 */
export function reportToMarkdown(report: UtilizationReport): string {
  const lines: string[] = [
    `### Utilization ${report.window.from} → ${report.window.to}`,
    "",
    toRow(HEADERS),
    toRow(HEADERS.map(() => "---")),
  ];

  for (const r of report.resources) {
    lines.push(
      toRow([
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

  lines.push(
    toRow([
      "**Total**",
      String(totalBookings),
      "",
      "",
      formatUtilization(report.averageUtilization),
      formatCents(report.totalRevenueCents),
    ]),
  );

  return lines.join("\n");
}
