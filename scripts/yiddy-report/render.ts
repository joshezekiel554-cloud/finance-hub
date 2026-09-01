// Bakes report-data.json (+ reviewed notes if present) into template.html.
// Usage: npx tsx scripts/yiddy-report/render.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ReportData } from "./types";

const OUT = "scripts/yiddy-report-out";
const report: ReportData = JSON.parse(readFileSync(`${OUT}/report-data.json`, "utf8"));

const notesPath = `${OUT}/notes-reviewed.json`;
if (existsSync(notesPath)) {
  const notes: Record<string, string | null> = JSON.parse(readFileSync(notesPath, "utf8"));
  for (const s of report.stores) s.note = notes[s.id] ?? null;
  console.log(`notes injected: ${Object.values(notes).filter(Boolean).length}`);
} else {
  console.warn("notes-reviewed.json not found — rendering WITHOUT sanitized notes");
}

const template = readFileSync("scripts/yiddy-report/template.html", "utf8");
// JSON inside <script> — escape "</" so a note can't break out of the tag.
const json = JSON.stringify(report).replace(/</g, "\\u003c");
const html = template.replace("/*__DATA__*/null", json);
const outFile = `${OUT}/yiddy-roster-report-${report.genDate.slice(0, 7)}.html`;
writeFileSync(outFile, html);
console.log(`wrote ${outFile} (${Math.round(html.length / 1024)} KB)`);
