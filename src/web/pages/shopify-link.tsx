// Shopify ID linker page. Two-stage flow:
//   1. Run scan → backend tries to auto-match every B2B customer to a
//      Shopify id via the email-first lookup. Newly-discovered ids are
//      already persisted by the time the response arrives.
//   2. For ambiguous + no-match rows, the operator can search Shopify
//      by company name and pick a candidate. Apply persists the picked
//      id.
//
// The "auto_matched" rows are informational — they're already linked,
// just shown so the operator can scan for surprises before walking
// away. "already_linked" rows are the noise floor.

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Mail,
  Search,
  ShoppingBag,
  User,
} from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { cn } from "../lib/cn";

type Classification =
  | "already_linked"
  | "auto_matched"
  | "ambiguous"
  | "no_match";

type PreviewRow = {
  customerId: string;
  displayName: string;
  primaryEmail: string | null;
  billingEmails: string[];
  classification: Classification;
  resolvedShopifyId: string | null;
  matchedEmail?: string;
  candidatesByEmail?: Record<string, string>;
};

type PreviewResponse = {
  rows: PreviewRow[];
  stats: {
    total: number;
    autoMatched: number;
    alreadyLinked: number;
    ambiguous: number;
    noMatch: number;
  };
};

type SearchHit = {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  city: string | null;
};

const CLASSIFICATION_LABEL: Record<
  Classification,
  { label: string; tone: "success" | "info" | "high" | "critical" | "neutral" }
> = {
  already_linked: { label: "Already linked", tone: "neutral" },
  auto_matched: { label: "Auto-matched", tone: "success" },
  ambiguous: { label: "Ambiguous", tone: "high" },
  no_match: { label: "No match", tone: "critical" },
};

export default function ShopifyLinkPage() {
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  // Operator-picked Shopify ids for ambiguous / no_match rows. Keyed by
  // customerId. Apply sends only the rows present here.
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [applyResult, setApplyResult] = useState<{
    updated: number;
    skipped: number;
    failures: Array<{ customerId: string; reason: string }>;
  } | null>(null);

  const previewMutation = useMutation<PreviewResponse>({
    mutationFn: async () => {
      const res = await fetch("/api/shopify-link/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: (data) => {
      setPreview(data);
      setPicks({});
      setApplyResult(null);
    },
  });

  const applyMutation = useMutation<
    NonNullable<typeof applyResult>,
    Error,
    Array<{ customerId: string; shopifyCustomerId: string }>
  >({
    mutationFn: async (applies) => {
      const res = await fetch("/api/shopify-link/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ applies }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: (data) => {
      setApplyResult(data);
      previewMutation.mutate();
    },
  });

  const rows = preview?.rows ?? [];
  const writableCount = useMemo(
    () => Object.values(picks).filter((v) => v.length > 0).length,
    [picks],
  );

  function applyPicks() {
    const applies: Array<{
      customerId: string;
      shopifyCustomerId: string;
    }> = [];
    for (const [customerId, shopifyCustomerId] of Object.entries(picks)) {
      if (shopifyCustomerId) {
        applies.push({ customerId, shopifyCustomerId });
      }
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
        <h1 className="text-xl font-semibold">Link customers to Shopify</h1>
        <p className="text-sm text-muted">
          Tries every email finance-hub knows for each B2B customer to find
          their Shopify record, persists the Shopify id when there's a
          single unambiguous match, and surfaces the rest for manual
          linking. After this runs the b2b-tag audit and hold/release
          flows use the saved id directly.
        </p>
      </div>

      {!preview ? (
        <Card>
          <CardBody>
            <div className="flex items-center justify-between">
              <div className="text-sm">
                Scan every B2B customer (~2–3 minutes). Auto-matches are
                saved as the scan runs; the table at the end shows what's
                left to link by hand.
              </div>
              <Button
                variant="primary"
                size="sm"
                onClick={() => previewMutation.mutate()}
                disabled={previewMutation.isPending}
              >
                {previewMutation.isPending ? "Scanning…" : "Run scan"}
              </Button>
            </div>
            {previewMutation.isError ? (
              <div className="mt-3 text-sm text-accent-danger">
                {String(previewMutation.error?.message ?? "scan failed")}
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {preview ? (
        <>
          <Card>
            <CardBody className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <Stat label="Total" value={preview.stats.total} />
              <Stat label="Auto-matched (saved)" value={preview.stats.autoMatched} />
              <Stat label="Already linked" value={preview.stats.alreadyLinked} />
              <Stat label="Ambiguous" value={preview.stats.ambiguous} />
              <Stat label="No match" value={preview.stats.noMatch} />
            </CardBody>
          </Card>

          {applyResult ? (
            <Card className="border-accent-success/40 bg-accent-success/5">
              <CardBody>
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="size-4 text-accent-success" />
                  <span className="font-medium">
                    Linked {applyResult.updated}
                    {applyResult.skipped > 0
                      ? `, ${applyResult.skipped} skipped (already set)`
                      : ""}
                    {applyResult.failures.length > 0
                      ? `, ${applyResult.failures.length} failed`
                      : ""}
                    .
                  </span>
                </div>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm">
                  <span className="font-medium">{writableCount}</span>{" "}
                  manual link{writableCount === 1 ? "" : "s"} ready to apply
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={applyPicks}
                  disabled={writableCount === 0 || applyMutation.isPending}
                >
                  {applyMutation.isPending
                    ? "Applying…"
                    : `Apply ${writableCount} link${writableCount === 1 ? "" : "s"}`}
                </Button>
              </div>
            </CardHeader>
            <CardBody className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-default text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">
                      Customer
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      Status
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      Shopify id
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      Manual link
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <LinkRow
                      key={r.customerId}
                      row={r}
                      pickedId={picks[r.customerId] ?? ""}
                      onPick={(id) =>
                        setPicks((p) => ({ ...p, [r.customerId]: id }))
                      }
                    />
                  ))}
                </tbody>
              </table>
            </CardBody>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function LinkRow({
  row,
  pickedId,
  onPick,
}: {
  row: PreviewRow;
  pickedId: string;
  onPick: (id: string) => void;
}) {
  const needsManual =
    row.classification === "ambiguous" || row.classification === "no_match";
  return (
    <tr
      className={cn(
        "border-b border-default last:border-0 align-top",
        needsManual ? "bg-accent-warning/5" : "",
      )}
    >
      <td className="px-3 py-2">
        <Link
          to="/customers/$customerId"
          params={{ customerId: row.customerId }}
          className="flex items-center gap-1 font-medium text-accent-primary hover:underline"
        >
          <User className="size-3" />
          {row.displayName}
        </Link>
        {row.primaryEmail ? (
          <div className="flex items-center gap-1 text-xs text-muted">
            <Mail className="size-3" />
            {row.primaryEmail}
          </div>
        ) : null}
      </td>
      <td className="px-3 py-2">
        <Badge tone={CLASSIFICATION_LABEL[row.classification].tone}>
          {CLASSIFICATION_LABEL[row.classification].label}
        </Badge>
        {row.matchedEmail ? (
          <div className="mt-0.5 text-[10px] text-muted">
            via {row.matchedEmail}
          </div>
        ) : null}
        {row.candidatesByEmail &&
        Object.keys(row.candidatesByEmail).length > 0 ? (
          <ul className="mt-0.5 text-[10px] text-muted">
            {Object.entries(row.candidatesByEmail).map(([email, id]) => (
              <li key={email}>
                {email} → <span className="font-mono">{id}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </td>
      <td className="px-3 py-2 text-secondary">
        {row.resolvedShopifyId ? (
          <span className="font-mono text-xs">{row.resolvedShopifyId}</span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="px-3 py-2">
        {needsManual ? (
          <ShopifySearchPicker
            initialQuery={row.displayName}
            pickedId={pickedId}
            onPick={onPick}
          />
        ) : null}
      </td>
    </tr>
  );
}

function ShopifySearchPicker({
  initialQuery,
  pickedId,
  onPick,
}: {
  initialQuery: string;
  pickedId: string;
  onPick: (id: string) => void;
}) {
  const [q, setQ] = useState(initialQuery);
  const [open, setOpen] = useState(false);

  const { data, isFetching, refetch } = useQuery<{ results: SearchHit[] }>({
    queryKey: ["shopify-link-search", q],
    queryFn: async () => {
      const params = new URLSearchParams({ q, limit: "10" });
      const res = await fetch(`/api/shopify-link/search?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: false,
    staleTime: 5 * 60_000,
  });

  function go() {
    if (!q.trim()) return;
    refetch();
    setOpen(true);
  }

  return (
    <div className="space-y-1">
      <div className="flex gap-1">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              go();
            }
          }}
          placeholder="Shopify ID, email, or company / contact name…"
          className="text-xs"
          title="Numeric → looked up by Shopify id directly. Anything with @ → email exact-match. Else → company / first / last name search."
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={go}
          disabled={!q.trim() || isFetching}
        >
          <Search className="size-3" /> Search
        </Button>
      </div>
      {open && data ? (
        <div className="rounded-md border border-default bg-base">
          {data.results.length === 0 ? (
            <div className="flex items-center gap-1 p-2 text-xs text-muted">
              <AlertCircle className="size-3" /> No Shopify customers
              matched.
            </div>
          ) : (
            <ul>
              {data.results.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    onClick={() => onPick(hit.id)}
                    className={cn(
                      "block w-full px-2 py-1 text-left text-xs hover:bg-elevated",
                      pickedId === hit.id ? "bg-accent-success/10" : "",
                    )}
                  >
                    <div className="flex items-center gap-1 font-medium">
                      <ShoppingBag className="size-3 text-muted" />
                      {hit.company || "(no company)"} —{" "}
                      <span className="font-mono">{hit.id}</span>
                      {pickedId === hit.id ? (
                        <span className="ml-auto text-[10px] text-accent-success">
                          picked
                        </span>
                      ) : null}
                    </div>
                    <div className="text-muted">
                      {[hit.firstName, hit.lastName].filter(Boolean).join(" ")}
                      {hit.email ? ` · ${hit.email}` : ""}
                      {hit.city ? ` · ${hit.city}` : ""}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <span className="text-muted">{label}: </span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
