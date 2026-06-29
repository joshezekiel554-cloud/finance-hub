// Manual CSV builder for the Team Activity timeline export (no papaparse dep).
// RFC-4180 quoting: wrap a field in double-quotes when it contains a comma,
// quote, CR or LF, and escape embedded quotes by doubling them.

import type { TeamActivityReport } from "./types.js";
import { londonDayKey } from "./helpers.js";

const HEADER = ["date", "time", "source", "type", "title", "detail", "customer"] as const;

function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * Render the report's timeline as CSV text. One row per event, newest first
 * (the report's days are already newest-first; events within a day too). Date
 * + time are rendered in Europe/London.
 */
export function reportToCsv(report: TeamActivityReport): string {
  const lines: string[] = [HEADER.join(",")];
  for (const day of report.days) {
    for (const ev of day.events) {
      const row = [
        londonDayKey(ev.at),
        timeFmt.format(new Date(ev.at)),
        ev.source,
        ev.type,
        ev.title,
        ev.detail ?? "",
        ev.customerName ?? "",
      ].map((f) => escapeCsvField(String(f)));
      lines.push(row.join(","));
    }
  }
  // Trailing newline so the file ends cleanly.
  return lines.join("\r\n") + "\r\n";
}

/** Filename-safe slug for the export attachment. */
export function csvFilename(report: TeamActivityReport): string {
  const who = (report.subject.name ?? report.subject.email ?? report.subject.userId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const from = londonDayKey(report.range.from);
  const to = londonDayKey(report.range.to);
  return `team-activity-${who}-${from}_to_${to}.csv`;
}
