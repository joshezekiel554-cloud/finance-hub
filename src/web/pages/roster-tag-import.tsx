// Roster-tag import. Apply a single tag (yiddy by default) to many
// customers in one go by pasting a list of names or uploading a CSV.
//
// Flow:
//   1. Operator picks a tag, then either pastes names (one per line)
//      or uploads a CSV (first column = store name).
//   2. Click "Preview" → POST /api/roster-tag with apply=false →
//      backend returns matched / already-tagged / ambiguous /
//      not-found buckets. UI renders them.
//   3. Operator reviews the not-found list (typos, account splits,
//      etc.) and edits the textarea if needed; can preview again.
//   4. Click "Apply" → POST /api/roster-tag with apply=true →
//      server updates customers.tags + writes audit_log per change.
//      Toast confirms count.

import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Tag,
  Upload,
} from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";

type ApiResponse = {
  applied: boolean;
  tag: string;
  counts: {
    input: number;
    matched: number;
    alreadyTagged: number;
    wouldApply?: number;
    applied?: number;
    ambiguous: number;
    notFound: number;
  };
  matches: Array<{
    rosterName: string;
    customerId: string;
    customerName: string;
    alreadyTagged: boolean;
  }>;
  ambiguous: Array<{ rosterName: string; candidates: string[] }>;
  notFound: string[];
};

// Minimal tolerant CSV parser. Handles quoted fields with embedded
// commas and double-quote escapes ("foo, bar" / "she said ""hi"""), but
// not multi-line cells (the roster CSVs we're parsing are flat). Header
// detection: if the first row has a "Store Name" / "Name" column, we
// pick that index; otherwise we default to column 0.
function parseCsvFirstColumn(text: string): string[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headerCells = parseCsvLine(lines[0]!);
  let nameColIdx = 0;
  const headerLower = headerCells.map((c) => c.toLowerCase().trim());
  const nameHints = ["store name", "customer name", "name", "store"];
  for (const hint of nameHints) {
    const idx = headerLower.indexOf(hint);
    if (idx !== -1) {
      nameColIdx = idx;
      break;
    }
  }
  // If the first row looks like a header (matches one of our hints),
  // skip it; otherwise treat row 0 as data.
  const startIdx = nameHints.some((h) => headerLower.includes(h)) ? 1 : 0;
  const out: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]!);
    const v = cells[nameColIdx]?.trim();
    if (v) out.push(v);
  }
  return out;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === ",") {
        cells.push(cur);
        cur = "";
      } else if (ch === '"' && cur.length === 0) {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
  }
  cells.push(cur);
  return cells;
}

export default function RosterTagImportPage() {
  const [tag, setTag] = useState<string>("yiddy");
  const [namesText, setNamesText] = useState<string>("");
  const [csvError, setCsvError] = useState<string | null>(null);

  const names = useMemo(
    () =>
      namesText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    [namesText],
  );

  const mutation = useMutation<ApiResponse, Error, { apply: boolean }>({
    mutationFn: async ({ apply }) => {
      const res = await fetch("/api/roster-tag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tag, names, apply }),
      });
      if (!res.ok) {
        const text = await res.text();
        let body: { error?: string } | null = null;
        try {
          body = JSON.parse(text) as { error?: string };
        } catch {
          /* not json */
        }
        throw new Error(body?.error ?? text ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
  });

  function onCsvUpload(file: File) {
    setCsvError(null);
    const reader = new FileReader();
    reader.onerror = () => {
      setCsvError(reader.error?.message ?? "failed to read file");
    };
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        setCsvError("expected text — was the file CSV?");
        return;
      }
      const extracted = parseCsvFirstColumn(result);
      if (extracted.length === 0) {
        setCsvError("no rows extracted — check the column header");
        return;
      }
      setNamesText(extracted.join("\n"));
    };
    reader.readAsText(file);
  }

  const result = mutation.data ?? null;

  return (
    <div className="space-y-4">
      <Link
        to="/settings"
        className="inline-flex items-center gap-1 text-xs text-secondary hover:text-primary"
      >
        <ArrowLeft className="size-3.5" />
        Back to settings
      </Link>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Roster — bulk-tag customers
        </h1>
        <p className="mt-1 text-sm text-secondary">
          Apply one tag to many customers at once. Paste names (one per
          line) or upload a CSV — first column is the store name.
          Preview shows you matches before any writes.
        </p>
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-medium">Setup</h2>
        </CardHeader>
        <CardBody className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-secondary">
              Tag to apply
            </label>
            <div className="mt-1 flex items-center gap-2">
              <Tag className="size-3.5 text-muted" />
              <input
                type="text"
                value={tag}
                onChange={(e) => setTag(e.target.value.toLowerCase())}
                className="w-48 rounded-md border border-default bg-base px-2 py-1 text-sm"
                placeholder="yiddy"
              />
              <span className="text-xs text-muted">
                lower-cased on save; matched against email_routing_rules.tag
              </span>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-secondary">
              Upload CSV
            </label>
            <div className="mt-1 flex items-center gap-2">
              <label
                htmlFor="roster-csv"
                className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-default bg-base px-3 py-1.5 text-xs font-medium text-secondary hover:bg-elevated hover:text-primary"
              >
                <Upload className="size-3.5" />
                Pick CSV
              </label>
              <input
                id="roster-csv"
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onCsvUpload(f);
                  // Reset so re-uploading the same file fires onChange.
                  e.target.value = "";
                }}
                className="hidden"
              />
              <span className="text-xs text-muted">
                first column = store name (header row auto-detected)
              </span>
            </div>
            {csvError ? (
              <div className="mt-1 flex items-center gap-1 text-xs text-accent-danger">
                <AlertCircle className="size-3.5" />
                {csvError}
              </div>
            ) : null}
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="block text-xs font-medium text-secondary">
                Names ({names.length})
              </label>
              {namesText.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setNamesText("")}
                  className="text-xs text-muted hover:text-accent-danger"
                >
                  clear
                </button>
              ) : null}
            </div>
            <textarea
              value={namesText}
              onChange={(e) => setNamesText(e.target.value)}
              placeholder={
                "Abraham Stern\nAlef Judaica\nApstone Interiors\n…"
              }
              rows={12}
              className="mt-1 w-full rounded-md border border-default bg-base px-2 py-1 text-sm font-mono"
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => mutation.mutate({ apply: false })}
              disabled={
                mutation.isPending || names.length === 0 || tag.length === 0
              }
              loading={mutation.isPending && !mutation.variables?.apply}
            >
              Preview matches
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => mutation.mutate({ apply: true })}
              disabled={
                mutation.isPending ||
                names.length === 0 ||
                tag.length === 0 ||
                !result ||
                (result.counts.wouldApply ?? 0) === 0
              }
              loading={mutation.isPending && mutation.variables?.apply}
              title={
                !result
                  ? "Preview first to see what would change"
                  : (result.counts.wouldApply ?? 0) === 0
                    ? "Nothing to apply (zero new matches)"
                    : `Apply tag to ${result.counts.wouldApply} customer(s)`
              }
            >
              Apply
            </Button>
          </div>

          {mutation.isError ? (
            <div className="flex items-start gap-2 rounded-md border border-accent-danger/30 bg-accent-danger/10 px-3 py-2 text-sm text-accent-danger">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <div>{(mutation.error as Error).message}</div>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {result ? <ResultsCard result={result} /> : null}
    </div>
  );
}

function ResultsCard({ result }: { result: ApiResponse }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">
            {result.applied ? "Applied" : "Preview"} —{" "}
            <span className="font-mono">{result.tag}</span>
          </h2>
          {result.applied ? (
            <Badge tone="success">
              <CheckCircle2 className="size-3" />
              {result.counts.applied ?? 0} customer(s) tagged
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
          <Stat label="Input" value={result.counts.input} />
          <Stat label="Matched" value={result.counts.matched} />
          <Stat
            label="Already tagged"
            value={result.counts.alreadyTagged}
            tone="muted"
          />
          {result.applied ? (
            <Stat
              label="Just applied"
              value={result.counts.applied ?? 0}
              tone="success"
            />
          ) : (
            <Stat
              label="Would apply"
              value={result.counts.wouldApply ?? 0}
              tone="info"
            />
          )}
        </div>

        {result.ambiguous.length > 0 ? (
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-accent-warning">
              Ambiguous ({result.ambiguous.length}) — same name matches
              more than one customer; skipped
            </div>
            <ul className="mt-1 space-y-1 text-xs">
              {result.ambiguous.map((a, i) => (
                <li key={i}>
                  <span className="font-medium">{a.rosterName}</span>
                  <span className="ml-2 text-muted">
                    matched: {a.candidates.join(" | ")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {result.notFound.length > 0 ? (
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-accent-danger">
              Not found ({result.notFound.length}) — fix in QBO or edit
              the name in the textarea
            </div>
            <ul className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
              {result.notFound.map((n, i) => (
                <li key={i} className="font-mono text-muted">
                  {n}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "muted" | "info" | "success";
}) {
  return (
    <div className="rounded-md border border-default bg-subtle px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted">
        {label}
      </div>
      <div
        className={
          tone === "success"
            ? "text-lg font-semibold tabular-nums text-accent-success"
            : tone === "info"
              ? "text-lg font-semibold tabular-nums text-accent-info"
              : tone === "muted"
                ? "text-lg font-semibold tabular-nums text-muted"
                : "text-lg font-semibold tabular-nums"
        }
      >
        {value}
      </div>
    </div>
  );
}
