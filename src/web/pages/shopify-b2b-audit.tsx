// Shopify B2B-tag audit. Reads every B2B customer's Shopify tag set
// and recommends the holdStatus value that matches Shopify reality:
//   has b2b, no upfront tag    → active
//   has b2b, has b2b-b2b-upfront → payment_upfront
//   missing b2b                → hold
//
// Operator-confirmed (preview before any DB writes). After applying,
// finance-hub is in sync with Shopify; from then on the customer-
// detail toggle / future audits keep it that way.

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  CircleDashed,
  Mail,
  Pause,
  ShoppingBag,
  User,
} from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { cn } from "../lib/cn";

type Status = "active" | "hold" | "payment_upfront";

type Classification =
  | "in_sync"
  | "drift"
  | "no_shopify_match"
  | "no_email"
  | "error";

type PreviewRow = {
  customerId: string;
  displayName: string;
  primaryEmail: string | null;
  classification: Classification;
  shopifyCustomerId: string | null;
  shopifyTags: string[];
  currentStatus: Status;
  desiredStatus: Status | null;
  recommended: boolean;
  errorMessage?: string;
};

type PreviewResponse = {
  rows: PreviewRow[];
  stats: {
    total: number;
    drift: number;
    driftToHold: number;
    driftToUpfront: number;
    driftToActive: number;
    inSync: number;
    noShopifyMatch: number;
    noEmail: number;
    error: number;
  };
};

type ApplyResponse = {
  updated: number;
  skipped: number;
  failures: Array<{ customerId: string; reason: string }>;
};

const STATUS_LABEL: Record<Status, string> = {
  active: "Active",
  hold: "Hold",
  payment_upfront: "Payment upfront",
};

const CLASSIFICATION_LABEL: Record<
  Classification,
  { label: string; tone: "success" | "high" | "critical" | "neutral" | "info" }
> = {
  drift: { label: "Drift", tone: "high" },
  in_sync: { label: "In sync", tone: "success" },
  no_shopify_match: { label: "No Shopify match", tone: "neutral" },
  no_email: { label: "No email", tone: "neutral" },
  error: { label: "Error", tone: "critical" },
};

function StatusPill({ status }: { status: Status }) {
  if (status === "hold") {
    return (
      <Badge tone="critical">
        <Pause className="mr-1 size-3" />
        Hold
      </Badge>
    );
  }
  if (status === "payment_upfront")
    return <Badge tone="high">Payment upfront</Badge>;
  return <Badge tone="success">Active</Badge>;
}

export default function ShopifyB2bAuditPage() {
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  // mondayId-equivalent here is customerId. Map of customerId → checked.
  // Defaults seeded from `recommended` once preview lands.
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [applyResult, setApplyResult] = useState<ApplyResponse | null>(null);

  const previewMutation = useMutation<PreviewResponse>({
    mutationFn: async () => {
      const res = await fetch("/api/shopify-b2b-audit/preview", {
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
      for (const r of data.rows) seed[r.customerId] = r.recommended;
      setSelected(seed);
      setApplyResult(null);
    },
  });

  const applyMutation = useMutation<
    ApplyResponse,
    Error,
    Array<{ customerId: string; status: Status }>
  >({
    mutationFn: async (applies) => {
      const res = await fetch("/api/shopify-b2b-audit/apply", {
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
  const checkedCount = useMemo(
    () => Object.values(selected).filter(Boolean).length,
    [selected],
  );
  const writableCount = useMemo(
    () =>
      rows.filter(
        (r) => selected[r.customerId] && r.classification === "drift" && r.desiredStatus,
      ).length,
    [rows, selected],
  );

  function toggleAll(checked: boolean, predicate: (r: PreviewRow) => boolean) {
    const next = { ...selected };
    for (const r of rows) if (predicate(r)) next[r.customerId] = checked;
    setSelected(next);
  }

  function applySelected() {
    const applies: Array<{ customerId: string; status: Status }> = [];
    for (const r of rows) {
      if (!selected[r.customerId]) continue;
      if (r.classification !== "drift" || !r.desiredStatus) continue;
      applies.push({ customerId: r.customerId, status: r.desiredStatus });
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
        <h1 className="text-xl font-semibold">Shopify B2B-tag audit</h1>
        <p className="text-sm text-muted">
          Brings the customer status into sync with Shopify tags. Has{" "}
          <code className="text-xs">b2b</code> → active. Has{" "}
          <code className="text-xs">b2b-b2b-upfront</code> →
          payment upfront. Missing <code className="text-xs">b2b</code> → hold.
        </p>
      </div>

      {!preview ? (
        <Card>
          <CardBody>
            <div className="flex items-center justify-between">
              <div className="text-sm">
                Scan every B2B customer in Shopify (~1 minute) and preview
                the status changes that would bring finance-hub into
                agreement. No customer data changes until you click Apply.
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
              <Stat label="Total scanned" value={preview.stats.total} />
              <Stat
                label="Drift → Hold"
                value={preview.stats.driftToHold}
              />
              <Stat
                label="Drift → Payment upfront"
                value={preview.stats.driftToUpfront}
              />
              <Stat
                label="Drift → Active"
                value={preview.stats.driftToActive}
              />
              <Stat label="In sync" value={preview.stats.inSync} />
              <Stat
                label="No Shopify match"
                value={preview.stats.noShopifyMatch}
              />
              <Stat label="Errors" value={preview.stats.error} />
            </CardBody>
          </Card>

          {applyResult ? (
            <Card className="border-accent-success/40 bg-accent-success/5">
              <CardBody>
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="size-4 text-accent-success" />
                  <span className="font-medium">
                    Applied: {applyResult.updated} updated
                    {applyResult.skipped > 0
                      ? `, ${applyResult.skipped} skipped (already correct)`
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
                  <span className="font-medium">{checkedCount}</span> checked
                  · <span className="font-medium">{writableCount}</span>{" "}
                  writable (drift + valid status)
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      toggleAll(
                        true,
                        (r) => r.classification === "drift",
                      )
                    }
                  >
                    Check all drift
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
                      Customer
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      Shopify tags
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      Diagnosis
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      Current → New
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const writable =
                      r.classification === "drift" && r.desiredStatus !== null;
                    return (
                      <tr
                        key={r.customerId}
                        className={cn(
                          "border-b border-default last:border-0",
                          r.recommended ? "bg-accent-warning/5" : "",
                        )}
                      >
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            disabled={!writable}
                            checked={Boolean(selected[r.customerId])}
                            onChange={(e) =>
                              setSelected((prev) => ({
                                ...prev,
                                [r.customerId]: e.target.checked,
                              }))
                            }
                          />
                        </td>
                        <td className="px-3 py-2">
                          <Link
                            to="/customers/$customerId"
                            params={{ customerId: r.customerId }}
                            className="flex items-center gap-1 font-medium text-accent-primary hover:underline"
                          >
                            <User className="size-3" />
                            {r.displayName}
                          </Link>
                          {r.primaryEmail ? (
                            <div className="flex items-center gap-1 text-xs text-muted">
                              <Mail className="size-3" />
                              {r.primaryEmail}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2">
                          {r.shopifyTags.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {r.shopifyTags.map((tag) => (
                                <span
                                  key={tag}
                                  className={cn(
                                    "rounded border border-default px-1.5 py-0.5 text-[10px]",
                                    tag.toLowerCase() === "b2b"
                                      ? "bg-accent-info/10 text-accent-info"
                                      : tag.toLowerCase() ===
                                          "b2b-b2b-upfront"
                                        ? "bg-accent-warning/10 text-accent-warning"
                                        : "text-secondary",
                                  )}
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="flex items-center gap-1 text-xs text-muted">
                              <CircleDashed className="size-3" />
                              {r.classification === "no_shopify_match"
                                ? "No Shopify customer"
                                : r.classification === "no_email"
                                  ? "No email on customer"
                                  : "—"}
                            </span>
                          )}
                          {r.errorMessage ? (
                            <div className="mt-0.5 flex items-center gap-1 text-[10px] text-accent-danger">
                              <AlertCircle className="size-3" />
                              {r.errorMessage}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2">
                          <Badge
                            tone={CLASSIFICATION_LABEL[r.classification].tone}
                            className="text-[10px]"
                          >
                            {CLASSIFICATION_LABEL[r.classification].label}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <StatusPill status={r.currentStatus} />
                          {r.desiredStatus &&
                          r.desiredStatus !== r.currentStatus ? (
                            <>
                              <span className="mx-1 text-muted">→</span>
                              <StatusPill status={r.desiredStatus} />
                            </>
                          ) : null}
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <span className="text-muted">{label}: </span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

// Used as a hint icon in the heading. Pulled in just for visual flavour.
void ShoppingBag;
