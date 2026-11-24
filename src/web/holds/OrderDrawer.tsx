import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, Loader2, Mail, MailX } from "lucide-react";
import { api, type HoldRow, type Me } from "./api";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { LADDER_STAGE_LABELS, MISMATCH_LABELS } from "../../modules/hold-orders/board-classify";
import {
  daysLabel,
  drawerActions,
  formatDate,
  formatDateTime,
  formatMoney,
  holdConfirmLabel,
  holdStateLabel,
  previewSummary,
  releaseBody,
  releaseConfirmLabel,
  roleLabel,
  tomorrowYmd,
  type EmailPreview,
  type HoldMode,
  type PaidOutsideMethod,
  type ReleaseDraft,
} from "./lib/view";
import { cn } from "../lib/cn";

export function OrderDrawer({ orderId, me, onClose }: { orderId: string; me: Me; onClose: () => void }) {
  const q = useQuery({ queryKey: ["holds-order", orderId], queryFn: () => api.order(orderId) });
  const [flash, setFlash] = useState<string | null>(null);
  const qc = useQueryClient();
  const refresh = (msg: string) => {
    setFlash(msg);
    void qc.invalidateQueries({ queryKey: ["holds-order", orderId] });
    void qc.invalidateQueries({ queryKey: ["holds-list"] });
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent
        className={cn(
          // Right-hand drawer: cancel the centring translate (dialog gotcha).
          "left-auto right-0 top-0 h-full max-h-screen w-full max-w-xl translate-x-0 translate-y-0 overflow-y-auto rounded-none border-y-0 border-r-0 p-0",
        )}
      >
        {q.isLoading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" /> Loading order…
          </div>
        ) : q.error || !q.data ? (
          <div className="p-6">
            <DialogTitle>Order not found</DialogTitle>
            <DialogDescription>{(q.error as Error | null)?.message ?? ""}</DialogDescription>
          </div>
        ) : (
          <DrawerBody row={q.data.row} timeline={q.data.timeline} me={me} flash={flash} onDone={refresh} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DrawerBody({
  row,
  timeline,
  me,
  flash,
  onDone,
}: {
  row: HoldRow;
  timeline: Array<{ at: string; actor: string; text: string; mode: string | null; emailed: Array<{ to: string; role: string; subject: string }> }>;
  me: Me;
  flash: string | null;
  onDone: (msg: string) => void;
}) {
  const perms = me.permissions!;
  const actions = drawerActions(row, perms);
  return (
    <div className="flex flex-col gap-5 p-4 pb-10 sm:p-6">
      <div className="pr-8">
        <DialogTitle className="flex flex-wrap items-baseline gap-2">
          <span className="tabular-nums">{row.orderNumber}</span>
          <span className="text-sm font-normal text-secondary">{row.customerName ?? "Unknown customer"}</span>
        </DialogTitle>
        <DialogDescription className="mt-1 flex flex-wrap items-center gap-2">
          <Badge tone={row.holdState === "on_hold" ? "critical" : row.holdState === "released" ? "success" : "neutral"}>
            {holdStateLabel(row.holdState)}
          </Badge>
          <span className="tabular-nums">{formatMoney(row.amount)}</span>
          {row.orderDate ? <span>ordered {formatDate(row.orderDate)}</span> : null}
        </DialogDescription>
      </div>

      {flash ? (
        <p role="status" className="rounded-lg border border-accent-success/40 bg-accent-success/10 px-3 py-2 text-sm text-primary">
          {flash}
        </p>
      ) : null}

      {row.mismatch ? (
        <p className="flex items-start gap-2 rounded-lg border border-accent-danger/40 bg-accent-danger/10 px-3 py-2 text-sm text-primary">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-accent-danger" aria-hidden />
          <span>
            {MISMATCH_LABELS[row.mismatch]}. Nothing was emailed about this — if the warehouse already sent it, use “Mark released — already told”.
          </span>
        </p>
      ) : null}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <Fact label={row.atRisk ? "Would hold" : "Why"}>{row.why}</Fact>
        {row.holdState === "on_hold" ? (
          <>
            <Fact label="Held">
              {formatDate(row.holdStartedAt)} · {daysLabel(row.daysHeld)}
            </Fact>
            <Fact label="Customer emails">
              {LADDER_STAGE_LABELS[row.ladderStage]}
              {row.pausedUntil ? ` until ${formatDate(row.pausedUntil)}` : ""}
              {row.pauseNote ? ` — ${row.pauseNote}` : ""}
            </Fact>
          </>
        ) : null}
        {row.promise ? (
          <Fact label="Promise">
            Promised to pay by {formatDate(row.promise.payBy)}
            {row.promise.note ? ` — ${row.promise.note}` : ""}
          </Fact>
        ) : null}
        <Fact label="Invoiced">
          {row.invoiced
            ? `QBO ${row.invoiced.docNumber} · ${row.invoiced.status ?? "open"} · ${formatMoney(row.invoiced.balance)} open`
            : "No QBO invoice yet"}
        </Fact>
        <Fact label="Shipped">
          {row.shipped
            ? `${row.shipped.source === "extensiv" ? "Warehouse (Extensiv)" : "Shopify"}${row.shipped.shipDate ? ` ${formatDate(row.shipped.shipDate)}` : ""}${row.shipped.carrier ? ` · ${row.shipped.carrier}` : ""}${row.shipped.trackingNumber ? ` · ${row.shipped.trackingNumber}` : ""}`
            : "Not shipped"}
        </Fact>
        {row.balance != null ? (
          <Fact label="Account">
            {formatMoney(row.balance)} balance · {formatMoney(row.overdueBalance)} overdue
          </Fact>
        ) : null}
      </dl>

      <div className="flex flex-wrap gap-3 text-xs">
        <LinkOut href={row.links.shopify}>Shopify order</LinkOut>
        {row.links.financeCustomer ? <LinkOut href={row.links.financeCustomer}>Finance customer</LinkOut> : null}
        <LinkOut href={me.hubUrl}>Hub</LinkOut>
      </div>

      {actions.canHold ? <HoldForm row={row} canRecordOnly={actions.canRecordOnly} onDone={onDone} /> : null}
      {actions.canRelease ? <ReleaseForm row={row} canRecordOnly={actions.canRecordOnly} onDone={onDone} /> : null}
      {actions.canPause ? <PauseForm row={row} canResume={actions.canResume} onDone={onDone} /> : null}
      {actions.canNote ? <NoteForm row={row} onDone={onDone} /> : null}

      <section aria-label="History">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">History</h3>
        {timeline.length === 0 ? (
          <p className="text-sm text-muted">No hold history yet.</p>
        ) : (
          <ol className="space-y-2 border-l border-default pl-4">
            {[...timeline].reverse().map((t, i) => (
              <li key={`${t.at}-${i}`} className="text-sm">
                <div className="text-primary">{t.text}</div>
                <div className="text-xs text-muted">
                  {formatDateTime(t.at)} · {t.actor}
                </div>
                {t.emailed.length > 0 ? (
                  <ul className="mt-1 space-y-0.5 text-xs text-secondary">
                    {t.emailed.map((e, j) => (
                      <li key={j} className="flex items-center gap-1">
                        <Mail className="size-3" aria-hidden /> {e.role}: {e.to}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-primary">{children}</dd>
    </>
  );
}

function LinkOut({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-primary hover:underline">
      {children} <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-default bg-subtle p-4" aria-label={title}>
      <h3 className="mb-3 text-sm font-semibold text-primary">{title}</h3>
      {children}
    </section>
  );
}

function ModeToggle({ mode, onMode, canRecordOnly }: { mode: HoldMode; onMode: (m: HoldMode) => void; canRecordOnly: boolean }) {
  return (
    <div role="radiogroup" aria-label="Who to tell" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {(
        [
          ["notify", "Email people", "Send the emails listed below."],
          ["record_only", "Record only — tell nobody", "Update the system silently. No email to anyone."],
        ] as const
      ).map(([m, label, sub]) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          disabled={m === "record_only" && !canRecordOnly}
          onClick={() => onMode(m)}
          className={cn(
            "rounded-lg border px-3 py-2 text-left text-sm disabled:opacity-50",
            mode === m ? "border-accent-primary bg-accent-primary/10" : "border-default bg-base hover:border-strong",
          )}
        >
          <span className="flex items-center gap-1.5 font-medium text-primary">
            {m === "notify" ? <Mail className="size-4" aria-hidden /> : <MailX className="size-4" aria-hidden />} {label}
          </span>
          <span className="text-xs text-secondary">{sub}</span>
        </button>
      ))}
    </div>
  );
}

function EmailList({ emails, shadowMode, loading }: { emails: EmailPreview[]; shadowMode: boolean; loading: boolean }) {
  if (loading) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted">
        <Loader2 className="size-3.5 animate-spin" /> Working out who gets emailed…
      </p>
    );
  }
  return (
    <div className="rounded-lg border border-default bg-base p-3">
      <p className="mb-1 text-xs font-medium text-secondary">{previewSummary(emails, shadowMode)}</p>
      {emails.length > 0 ? (
        <ul className="space-y-2">
          {emails.map((e, i) => (
            <li key={i} className="text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={e.role === "customer" ? "high" : "info"}>{roleLabel(e.role)}</Badge>
                <span className="text-muted">{e.when === "now" ? "now" : "next sync (~15 min)"}</span>
              </div>
              <div className="mt-0.5 break-all text-primary">To: {e.to}</div>
              {e.cc ? <div className="break-all text-secondary">Cc: {e.cc}</div> : null}
              <div className="text-secondary">“{e.subject}”</div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function useActionPreview(orderId: string, params: Record<string, string> | null) {
  return useQuery({
    queryKey: ["holds-preview", orderId, params],
    queryFn: () => api.preview(orderId, params!),
    enabled: params !== null,
    staleTime: 10_000,
  });
}

function HoldForm({ row, canRecordOnly, onDone }: { row: HoldRow; canRecordOnly: boolean; onDone: (m: string) => void }) {
  const [reason, setReason] = useState<"manual" | "overdue_non_communicating">("manual");
  const [note, setNote] = useState("");
  // Default for Hold: email people (and show exactly who below).
  const [mode, setMode] = useState<HoldMode>("notify");
  const [startLadder, setStartLadder] = useState(false);
  const params = {
    action: "hold",
    mode,
    reason,
    // The note only changes the email body, not who's emailed — left out so
    // the preview doesn't refetch on every keystroke.
    startLadder: String(mode === "notify" && startLadder),
  };
  const preview = useActionPreview(row.orderId, params);
  const m = useMutation({
    mutationFn: () => api.hold(row.orderId, { reason, note: note.trim() || undefined, startLadder: mode === "notify" && startLadder, mode }),
    onSuccess: () => onDone(mode === "record_only" ? "Hold recorded — nobody was emailed." : "Order held — emails sent as listed."),
  });
  return (
    <Panel title="Put on hold">
      <div className="space-y-3">
        <label className="block text-xs text-secondary">
          Reason
          <Select value={reason} onChange={(e) => setReason(e.target.value as typeof reason)} className="mt-1">
            <option value="manual">Manual hold (stays until someone releases it)</option>
            <option value="overdue_non_communicating">Overdue balance (auto-releases when it's paid in QBO)</option>
          </Select>
        </label>
        <label className="block text-xs text-secondary">
          Note (shown to the warehouse in the alert)
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="mt-1" placeholder="Optional" />
        </label>
        <ModeToggle mode={mode} onMode={setMode} canRecordOnly={canRecordOnly} />
        {mode === "notify" ? (
          <label className="flex items-start gap-2 text-sm text-primary">
            <input type="checkbox" className="mt-1" checked={startLadder} onChange={(e) => setStartLadder(e.target.checked)} />
            <span>
              Also chase the customer (Day-0 notice, Day-7 warning, Day-10 cancel notice)
            </span>
          </label>
        ) : null}
        <EmailList emails={preview.data?.emails ?? []} shadowMode={preview.data?.shadowMode ?? false} loading={preview.isLoading} />
        {m.error ? <p className="text-xs text-accent-danger">{(m.error as Error).message}</p> : null}
        <Button
          variant={mode === "record_only" ? "secondary" : "danger"}
          loading={m.isPending}
          disabled={preview.isLoading}
          onClick={() => m.mutate()}
          className="w-full sm:w-auto"
        >
          {holdConfirmLabel(mode, preview.data?.emails ?? [])}
        </Button>
      </div>
    </Panel>
  );
}

const PAID_METHODS: Array<[PaidOutsideMethod, string]> = [
  ["cheque", "Cheque"],
  ["stripe", "Stripe"],
  ["bank", "Bank transfer"],
  ["other", "Other"],
];

function ReleaseForm({ row, canRecordOnly, onDone }: { row: HoldRow; canRecordOnly: boolean; onDone: (m: string) => void }) {
  const [draft, setDraft] = useState<ReleaseDraft>({ paidOutside: false, method: "cheque", paidNote: "", note: "" });
  const [pending, setPending] = useState<HoldMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preview = useActionPreview(row.orderId, pending ? { action: "release", mode: pending } : null);
  const m = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.release(row.orderId, body),
    onSuccess: (_r, body) =>
      onDone(body.mode === "record_only" ? "Marked released — nobody was emailed." : "Released — warehouse told to ship."),
  });
  const confirm = () => {
    if (!pending) return;
    const b = releaseBody(pending, draft);
    if (!b.ok) {
      setError(b.error);
      return;
    }
    setError(null);
    m.mutate(b.body);
  };
  return (
    <Panel title="Release">
      <div className="space-y-3">
        <label className="flex items-start gap-2 text-sm text-primary">
          <input
            type="checkbox"
            className="mt-1"
            checked={draft.paidOutside}
            onChange={(e) => setDraft({ ...draft, paidOutside: e.target.checked })}
          />
          <span>Paid outside QBO (cheque / Stripe / other) — not in QuickBooks yet</span>
        </label>
        {draft.paidOutside ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[10rem_1fr]">
            <Select value={draft.method} onChange={(e) => setDraft({ ...draft, method: e.target.value as PaidOutsideMethod })} aria-label="How it was paid">
              {PAID_METHODS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
            <Input
              value={draft.paidNote}
              onChange={(e) => setDraft({ ...draft, paidNote: e.target.value })}
              placeholder="Cheque #, Stripe ref, who confirmed…"
              aria-label="Payment details"
              maxLength={500}
            />
          </div>
        ) : null}
        <label className="block text-xs text-secondary">
          Note
          <Input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} className="mt-1" placeholder="Optional" maxLength={500} />
        </label>

        {pending === null ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button onClick={() => setPending("notify")}>{releaseConfirmLabel("notify")}</Button>
            <Button variant="secondary" disabled={!canRecordOnly} onClick={() => setPending("record_only")}>
              {releaseConfirmLabel("record_only")}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <EmailList emails={preview.data?.emails ?? []} shadowMode={preview.data?.shadowMode ?? false} loading={preview.isLoading} />
            {error || m.error ? <p className="text-xs text-accent-danger">{error ?? (m.error as Error).message}</p> : null}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button loading={m.isPending} disabled={preview.isLoading} onClick={confirm} variant={pending === "record_only" ? "secondary" : "primary"}>
                Confirm: {releaseConfirmLabel(pending)}
              </Button>
              <Button variant="ghost" onClick={() => setPending(null)}>
                Back
              </Button>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

function PauseForm({ row, canResume, onDone }: { row: HoldRow; canResume: boolean; onDone: (m: string) => void }) {
  const [until, setUntil] = useState(tomorrowYmd());
  const [note, setNote] = useState("");
  const pause = useMutation({
    mutationFn: () => api.pause(row.orderId, { until, note: note.trim() || undefined }),
    onSuccess: () => onDone(`Customer emails paused until ${formatDate(until)}. The order stays held.`),
  });
  const resume = useMutation({
    mutationFn: () => api.resume(row.orderId),
    onSuccess: () => onDone("Customer emails resumed."),
  });
  return (
    <Panel title="Pause customer emails">
      <p className="mb-3 text-xs text-secondary">
        Stops the Day-0/7/10 chase until a date (e.g. they promised to pay). The order stays held; nobody is emailed about the pause.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[11rem_1fr_auto]">
        <Input type="date" value={until} min={tomorrowYmd()} onChange={(e) => setUntil(e.target.value)} aria-label="Pause until" />
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why (optional)" maxLength={300} aria-label="Pause note" />
        <Button variant="secondary" loading={pause.isPending} onClick={() => pause.mutate()}>
          Pause
        </Button>
      </div>
      {canResume ? (
        <Button variant="ghost" size="sm" className="mt-2" loading={resume.isPending} onClick={() => resume.mutate()}>
          Resume now
        </Button>
      ) : null}
      {pause.error || resume.error ? (
        <p className="mt-2 text-xs text-accent-danger">{((pause.error ?? resume.error) as Error).message}</p>
      ) : null}
    </Panel>
  );
}

function NoteForm({ row, onDone }: { row: HoldRow; onDone: (m: string) => void }) {
  const [note, setNote] = useState("");
  const m = useMutation({
    mutationFn: () => api.note(row.orderId, note.trim()),
    onSuccess: () => {
      setNote("");
      onDone("Note added.");
    },
  });
  return (
    <Panel title="Add a note">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        maxLength={1000}
        className="w-full rounded-md border border-default bg-base px-3 py-2 text-sm text-primary focus:border-accent-primary focus:outline-none"
        placeholder="Spoke to the buyer, cheque in the post…"
        aria-label="Note"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-muted">Notes go on this order's history only. Nobody is emailed.</span>
        <Button size="sm" variant="secondary" disabled={!note.trim()} loading={m.isPending} onClick={() => m.mutate()}>
          Add note
        </Button>
      </div>
    </Panel>
  );
}
