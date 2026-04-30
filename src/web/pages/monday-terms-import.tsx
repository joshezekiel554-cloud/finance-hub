// Monday → Finance Hub terms backfill UI. One-time importer.
//
// Flow:
//   1. Operator clicks "Run preview" → POST /api/monday-sync/preview-terms
//      returns 140 rows classified by match confidence + recommended flag
//   2. UI renders a table; recommended rows are checked by default,
//      ambiguous/unmatched/unrecognized are unchecked
//   3. Operator scans, untick anything wrong, hit "Apply selected" →
//      POST /api/monday-sync/apply-terms with the list
//   4. Toast confirms write counts; refetch preview to show no-op state

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  CircleDashed,
  Mail,
  User,
} from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { cn } from "../lib/cn";

type Via = "email" | "name" | "name_ambiguous" | "none";

type PreviewRow = {
  mondayId: string;
  mondayName: string;
  mondayEmail: string | null;
  mondayTerms: string | null;
  mappedTerm: string | null;
  match: {
    customerId: string | null;
    customerName: string | null;
    currentTerm: string | null;
    via: Via;
    matchedEmail?: string;
    candidates?: Array<{ id: string; displayName: string }>;
  };
  recommended: boolean;
};

type PreviewResponse = {
  rows: PreviewRow[];
  stats: {
    total: number;
    matchedByEmail: number;
    matchedByName: number;
    ambiguous: number;
    unmatched: number;
    recommended: number;
    unrecognizedTerms: number;
  };
};

type ApplyResponse = {
  updated: number;
  skipped: number;
  failures: Array<{ customerId: string; reason: string }>;
};

const VIA_LABELS: Record<Via, { label: string; tone: "info" | "success" | "high" | "neutral" }> = {
  email: { label: "Email match", tone: "success" },
  name: { label: "Name match", tone: "info" },
  name_ambiguous: { label: "Ambiguous", tone: "high" },
  none: { label: "No match", tone: "neutral" },
};

export default function MondayTermsImportPage() {
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  // mondayId → checked. Defaults seeded from `recommended` once preview lands.
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [applyResult, setApplyResult] = useState<ApplyResponse | null>(null);

  const previewMutation = useMutation<PreviewResponse>({
    mutationFn: async () => {
      const res = await fetch("/api/monday-sync/preview-terms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: (data) => {
      setPreview(data);
      const seed: Record<string, boolean> = {};
      for (const r of data.rows) seed[r.mondayId] = r.recommended;
      setSelected(seed);
      setApplyResult(null);
    },
  });

  const applyMutation = useMutation<
    ApplyResponse,
    Error,
    Array<{ customerId: string; term: string }>
  >({
    mutationFn: async (applies) => {
      const res = await fetch("/api/monday-sync/apply-terms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ applies }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: (data) => {
      setApplyResult(data);
      // Refetch preview so the table reflects the new "current" terms
      // (rows that were just written show currentTerm == mappedTerm and
      // drop out of the recommended set).
      previewMutation.mutate();
    },
  });

  const rows = preview?.rows ?? [];
  const checkedCount = useMemo(
    () => Object.values(selected).filter(Boolean).length,
    [selected],
  );
  const writableCount = useMemo(
    () =>
      rows.filter(
        (r) =>
          selected[r.mondayId] && r.match.customerId && r.mappedTerm,
      ).length,
    [rows, selected],
  );

  function toggleAll(checked: boolean, predicate: (r: PreviewRow) => boolean) {
    const next = { ...selected };
    for (const r of rows) {
      if (predicate(r)) next[r.mondayId] = checked;
    }
    setSelected(next);
  }

  function applySelected() {
    const applies: Array<{ customerId: string; term: string }> = [];
    for (const r of rows) {
      if (!selected[r.mondayId]) continue;
      if (!r.match.customerId || !r.mappedTerm) continue;
      applies.push({ customerId: r.match.customerId, term: r.mappedTerm });
    }
    if (applies.length === 0) return;
    applyMutation.mutate(applies);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link to="/settings">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="size-3.5" /> Settings
          </Button>
        </Link>
      </div>

      <div>
        <h1 className="text-xl font-semibold">Monday — terms import</h1>
        <p className="text-sm text-muted">
          One-time backfill of payment terms from the USA Stores Information
          board. After this runs, edit terms inside this app — Monday isn't
          re-queried.
        </p>
      </div>

      {!preview ? (
        <Card>
          <CardBody>
            <div className="flex items-center justify-between">
              <div className="text-sm">
                Pull the latest rows from the Monday board and preview the
                proposed writes. No customer data changes until you hit
                "Apply" below.
              </div>
              <Button
                variant="primary"
                size="sm"
                onClick={() => previewMutation.mutate()}
                disabled={previewMutation.isPending}
              >
                {previewMutation.isPending ? "Loading…" : "Run preview"}
              </Button>
            </div>
            {previewMutation.isError ? (
              <div className="mt-3 text-sm text-accent-danger">
                {String(previewMutation.error?.message ?? "preview failed")}
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {preview ? (
        <>
          <StatStrip stats={preview.stats} />

          {applyResult ? (
            <Card className="border-accent-success/40 bg-accent-success/5">
              <CardBody>
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="size-4 text-accent-success" />
                  <span className="font-medium">
                    Applied: {applyResult.updated} updated
                    {applyResult.skipped > 0
                      ? `, ${applyResult.skipped} skipped (already set)`
                      : ""}
                    {applyResult.failures.length > 0
                      ? `, ${applyResult.failures.length} failed`
                      : ""}
                    .
                  </span>
                </div>
                {applyResult.failures.length > 0 ? (
                  <ul className="mt-2 text-xs text-secondary">
                    {applyResult.failures.slice(0, 5).map((f, i) => (
                      <li key={i}>
                        {f.customerId}: {f.reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm">
                  <span className="font-medium">{checkedCount}</span> checked
                  · <span className="font-medium">{writableCount}</span>{" "}
                  writable (matched + valid term)
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => toggleAll(true, (r) => r.recommended)}
                  >
                    Check recommended
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => toggleAll(false, () => true)}
                  >
                    Uncheck all
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={applySelected}
                    disabled={
                      writableCount === 0 || applyMutation.isPending
                    }
                  >
                    {applyMutation.isPending
                      ? "Applying…"
                      : `Apply ${writableCount} selected`}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardBody className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-default text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Apply</th>
                    <th className="px-3 py-2 text-left font-medium">
                      Monday store
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      Monday terms
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      Match
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      Customer
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      Current → New
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const writable = Boolean(
                      r.match.customerId && r.mappedTerm,
                    );
                    return (
                      <tr
                        key={r.mondayId}
                        className={cn(
                          "border-b border-default last:border-0",
                          r.recommended ? "bg-accent-primary/5" : "",
                        )}
                      >
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            disabled={!writable}
                            checked={Boolean(selected[r.mondayId])}
                            onChange={(e) =>
                              setSelected((prev) => ({
                                ...prev,
                                [r.mondayId]: e.target.checked,
                              }))
                            }
                          />
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-medium text-primary">
                            {r.mondayName}
                          </div>
                          {r.mondayEmail ? (
                            <div className="flex items-center gap-1 text-xs text-muted">
                              <Mail className="size-3" />
                              {r.mondayEmail}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2">
                          {r.mondayTerms ? (
                            <span className="text-secondary">
                              {r.mondayTerms}
                            </span>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                          {r.mondayTerms && !r.mappedTerm ? (
                            <div className="mt-0.5 flex items-center gap-1 text-[10px] text-accent-warning">
                              <AlertCircle className="size-3" />
                              not recognised
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2">
                          <Badge
                            tone={VIA_LABELS[r.match.via].tone}
                            className="text-[10px]"
                          >
                            {VIA_LABELS[r.match.via].label}
                          </Badge>
                          {r.match.matchedEmail ? (
                            <div className="mt-0.5 text-[10px] text-muted">
                              via {r.match.matchedEmail}
                            </div>
                          ) : null}
                          {r.match.candidates &&
                          r.match.candidates.length > 0 ? (
                            <div className="mt-0.5 text-[10px] text-muted">
                              {r.match.candidates.length} candidates
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2">
                          {r.match.customerId ? (
                            <Link
                              to="/customers/$customerId"
                              params={{
                                customerId: r.match.customerId,
                              }}
                              className="flex items-center gap-1 text-accent-primary hover:underline"
                            >
                              <User className="size-3" />
                              {r.match.customerName}
                            </Link>
                          ) : (
                            <span className="flex items-center gap-1 text-muted">
                              <CircleDashed className="size-3" />
                              —
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className="text-muted">
                            {r.match.currentTerm ?? "—"}
                          </span>
                          <span className="mx-1 text-muted">→</span>
                          <span
                            className={cn(
                              r.mappedTerm
                                ? "font-medium text-primary"
                                : "text-muted",
                            )}
                          >
                            {r.mappedTerm ?? "—"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardBody>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function StatStrip({
  stats,
}: {
  stats: PreviewResponse["stats"];
}) {
  const items: Array<{ label: string; value: number; tone?: string }> = [
    { label: "Total rows", value: stats.total },
    { label: "By email", value: stats.matchedByEmail },
    { label: "By name", value: stats.matchedByName },
    { label: "Ambiguous", value: stats.ambiguous },
    { label: "Unmatched", value: stats.unmatched },
    { label: "Unrecognised terms", value: stats.unrecognizedTerms },
    { label: "Recommended", value: stats.recommended },
  ];
  return (
    <Card>
      <CardBody className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {items.map((it) => (
          <div key={it.label}>
            <span className="text-muted">{it.label}: </span>
            <span className="font-medium tabular-nums">{it.value}</span>
          </div>
        ))}
      </CardBody>
    </Card>
  );
}
