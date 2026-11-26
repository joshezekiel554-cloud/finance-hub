// Hold Orders SPA — API client + wire types (mirrors src/server/routes/holds-app.ts).

import type { HoldTab, LadderStage, Mismatch, ShippedInfo } from "../../modules/hold-orders/board-classify";
import type { HoldsPermissions, HoldsRole } from "../../modules/hold-orders/permissions";
import type { HoldRulePreset } from "../../modules/hold-orders/presets";
import type { HoldsConfig, HoldsConfigPatch, LastChanged } from "../../modules/hold-orders/holds-settings";
import type { EmailPreview } from "./lib/view";
import type { CandidateSource, ExclusionKind } from "./lib/settings-form";

export type Me = {
  user: { id: string; email: string | null; name: string | null; image: string | null } | null;
  role: HoldsRole | null;
  permissions: HoldsPermissions | null;
  hubUrl: string;
  financeUrl: string | null;
  shadowMode: boolean;
};

export type HoldRow = {
  orderId: string;
  orderNumber: string;
  shopifyOrderId: string;
  orderDate: string | null;
  amount: string | null;
  customerId: string | null;
  customerName: string | null;
  balance?: string | null;
  overdueBalance?: string | null;
  holdState: string;
  holdReason: string | null;
  why: string;
  holdStartedAt: string | null;
  daysHeld: number;
  ladderStage: LadderStage;
  chasing: boolean;
  pausedUntil: string | null;
  pauseNote: string | null;
  promise: { payBy: string; note: string | null; emailUrl: string | null } | null;
  releasedAt: string | null;
  invoiced: { docNumber: string; status: string | null; balance: string } | null;
  shipped: ShippedInfo | null;
  mismatch: Mismatch | null;
  atRisk: boolean;
  tabs: HoldTab[];
  links: { shopify: string; financeCustomer: string | null };
};

export type ListResponse = {
  rows: HoldRow[];
  total: number;
  nextCursor: string | null;
  counts: Record<HoldTab, number>;
  generatedAt: string;
};

export type TimelineEntry = {
  at: string;
  action: string;
  actor: string;
  text: string;
  mode: string | null;
  emailed: Array<{ to: string; role: string; template: string; subject: string }>;
};

export type PreviewResponse = { emails: EmailPreview[]; shadowMode: boolean };

export type RuleShape = {
  preset: HoldRulePreset;
  termsDays: number;
  holdWhenInvoiceDaysOver: number;
  minBalance: number;
  autoStartLadder: boolean;
  autoReleaseOnPayment: boolean;
  notifyWarehouse: boolean;
  note: string | null;
};

export type StoredRule = RuleShape & {
  customerId: string;
  customerName: string | null;
  setAt: string;
  updatedAt: string;
};

export type RulePreviewResponse = {
  rule: RuleShape;
  evaluation: { wouldHold: boolean; why: string | null; openBalance: number; hits: Array<{ docNumber: string | null; ageDays: number; balance: number }> };
  orders: Array<{ orderId: string; orderNumber: string | null; total: string | null }>;
};

export type CustomerHit = {
  id: string;
  name: string;
  paymentTerms: string | null;
  balance: string;
  overdueBalance: string;
  holdStatus: string | null;
};

export type FoundOrder = {
  orderId: string;
  orderNumber: string | null;
  shopifyOrderId: string;
  orderDate: string | null;
  total: string | null;
  holdState: string | null;
  customerName: string | null;
};

export type SettingsResponse = {
  values: HoldsConfig;
  defaults: HoldsConfig;
  canEdit: boolean;
  lastChanged: LastChanged | null;
  // b2b customers with no rule of their own (who the default rule would cover).
  defaultRuleScopeCount: number;
};

export type SettingsPreviewResponse = {
  draft: {
    hold: { count: number; orders: PreviewOrder[] };
    flag: { count: number; orders: PreviewOrder[] };
  };
  current: { hold: number; flag: number };
};

export type PreviewOrder = { orderId: string; orderNumber: string | null; customerName: string | null; reason: string };

export type ExclusionGroup = {
  kind: ExclusionKind;
  count: number;
  items: Array<{ customerId: string; customerName: string | null; orderId?: string; orderNumber?: string | null }>;
};

export type CandidateRow = {
  id: string;
  name: string;
  email: string | null;
  customerType: string | null;
  holdStatus: string | null;
  balance: string | null;
  overdueBalance: string | null;
  rule: { preset: HoldRulePreset; label: string } | null;
  defaultScope: boolean;
};

export type CandidatesResponse = {
  source: CandidateSource;
  rows: CandidateRow[];
  unmatched: Array<{ shopifyId: string; name: string; email: string | null }>;
  unmatchedCount?: number;
  fetched?: number;
  fetchedAt: string | null;
};

export type BulkPreviewResponse = {
  targets: number;
  skippedExisting: number;
  unknown: number;
  orderCount: number;
  customersHit: number;
  orders: Array<{ orderId: string; orderNumber: string | null; customerName: string | null; total: string | null; why: string }>;
};

export type BulkApplyResponse = { ok: true; applied: number; unchanged: number; skippedExisting: number; unknown: number };

export type BulkBody = { customerIds: string[]; rule: Record<string, unknown>; overwrite: boolean };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/holds${path}`, {
    credentials: "same-origin",
    ...init,
    headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = (json as { error?: unknown }).error;
    throw new ApiError(typeof err === "string" ? err : `Request failed (${res.status})`, res.status, json);
  }
  return json as T;
}

export const api = {
  me: () => call<Me>("/me"),
  list: (p: { status: HoldTab; search?: string; cursor?: string | null }) => {
    const q = new URLSearchParams({ status: p.status, limit: "50" });
    if (p.search) q.set("search", p.search);
    if (p.cursor) q.set("cursor", p.cursor);
    return call<ListResponse>(`/?${q.toString()}`);
  },
  find: (q: string) => call<{ orders: FoundOrder[] }>(`/find?${new URLSearchParams({ q }).toString()}`),
  order: (id: string) => call<{ row: HoldRow; timeline: TimelineEntry[] }>(`/${encodeURIComponent(id)}`),
  preview: (id: string, params: Record<string, string>) =>
    call<PreviewResponse>(`/${encodeURIComponent(id)}/preview?${new URLSearchParams(params).toString()}`),
  hold: (id: string, body: Record<string, unknown>) =>
    call<{ ok: true; emailed: EmailPreview[] }>(`/${encodeURIComponent(id)}/hold`, { method: "POST", body: JSON.stringify(body) }),
  release: (id: string, body: Record<string, unknown>) =>
    call<{ ok: true; emailed: EmailPreview[] }>(`/${encodeURIComponent(id)}/release`, { method: "POST", body: JSON.stringify(body) }),
  pause: (id: string, body: { until: string; note?: string }) =>
    call<{ ok: true }>(`/${encodeURIComponent(id)}/pause`, { method: "POST", body: JSON.stringify(body) }),
  resume: (id: string) => call<{ ok: true }>(`/${encodeURIComponent(id)}/pause`, { method: "DELETE" }),
  note: (id: string, note: string) =>
    call<{ ok: true }>(`/${encodeURIComponent(id)}/note`, { method: "POST", body: JSON.stringify({ note }) }),
  rules: () => call<{ rules: StoredRule[]; canEdit: boolean }>("/rules"),
  rule: (customerId: string) => call<{ rule: StoredRule | null; canEdit: boolean }>(`/rules/${encodeURIComponent(customerId)}`),
  customers: (q: string) => call<{ customers: CustomerHit[] }>(`/rules/customers?${new URLSearchParams({ q }).toString()}`),
  previewRule: (customerId: string, rule: Record<string, unknown>) =>
    call<RulePreviewResponse>("/rules/preview", { method: "POST", body: JSON.stringify({ customerId, rule }) }),
  saveRule: (customerId: string, rule: Record<string, unknown>) =>
    call<{ ok: true }>(`/rules/${encodeURIComponent(customerId)}`, { method: "PUT", body: JSON.stringify(rule) }),
  deleteRule: (customerId: string) => call<{ ok: true }>(`/rules/${encodeURIComponent(customerId)}`, { method: "DELETE" }),
  candidates: (source: CandidateSource, preset?: HoldRulePreset) =>
    call<CandidatesResponse>("/rules/candidates", { method: "POST", body: JSON.stringify({ source, preset }) }),
  bulkPreview: (body: BulkBody) =>
    call<BulkPreviewResponse>("/rules/bulk-preview", { method: "POST", body: JSON.stringify(body) }),
  bulkApply: (body: BulkBody) => call<BulkApplyResponse>("/rules/bulk-apply", { method: "POST", body: JSON.stringify(body) }),
  settings: () => call<SettingsResponse>("/settings"),
  exclusions: () => call<{ groups: ExclusionGroup[]; financeUrl: string | null }>("/settings/exclusions"),
  previewSettings: (draft: HoldsConfigPatch) =>
    call<SettingsPreviewResponse>("/settings/preview", { method: "POST", body: JSON.stringify({ draft }) }),
  saveSettings: (patch: HoldsConfigPatch) =>
    call<{ ok: true; changed: string[]; values: HoldsConfig }>("/settings", { method: "PATCH", body: JSON.stringify(patch) }),
};
