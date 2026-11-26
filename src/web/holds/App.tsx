import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Loader2, PackageX } from "lucide-react";
import { api, ApiError, type Me } from "./api";
import { HoldsList } from "./HoldsList";
import { OrderDrawer } from "./OrderDrawer";
import { RulesPanel } from "./RulesPanel";
import { SettingsPanel } from "./SettingsPanel";
import { parseTab } from "./lib/view";
import type { HoldTab } from "../../modules/hold-orders/board-classify";
import { cn } from "../lib/cn";

type View = "holds" | "rules" | "settings";

const VIEWS: View[] = ["holds", "rules", "settings"];
const VIEW_LABELS: Record<View, string> = { holds: "Orders", rules: "Customer rules", settings: "Settings" };

function parseView(v: string | null): View {
  return v === "rules" || v === "settings" ? v : "holds";
}

type UrlState = { view: View; tab: HoldTab; order: string | null };

function readUrl(): UrlState {
  const p = new URLSearchParams(window.location.search);
  return {
    view: parseView(p.get("view")),
    tab: parseTab(p.get("tab")),
    order: p.get("order"),
  };
}

function writeUrl(s: UrlState): void {
  const p = new URLSearchParams();
  if (s.view !== "holds") p.set("view", s.view);
  if (s.tab !== "held") p.set("tab", s.tab);
  if (s.order) p.set("order", s.order);
  const qs = p.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
}

export default function HoldsApp() {
  const me = useQuery({ queryKey: ["holds-me"], queryFn: api.me, staleTime: 5 * 60_000 });
  const [url, setUrl] = useState<UrlState>(readUrl);
  const update = useCallback((patch: Partial<UrlState>) => {
    setUrl((prev) => {
      const next = { ...prev, ...patch };
      writeUrl(next);
      return next;
    });
  }, []);

  useEffect(() => {
    document.title = url.view === "holds" ? "Hold Orders · Feldart" : `${VIEW_LABELS[url.view]} · Hold Orders`;
  }, [url.view]);

  if (me.isLoading) {
    return (
      <div className="grid min-h-screen place-items-center text-muted">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  if (me.error) {
    const msg = me.error instanceof ApiError ? me.error.message : "Couldn't reach Hold Orders.";
    return <Centered title="Something went wrong" body={msg} />;
  }
  const data = me.data;
  if (!data?.user) return <SignIn hubUrl={data?.hubUrl ?? "https://hub.feldart.com"} />;
  if (!data.role || !data.permissions) {
    return (
      <Centered
        title="No access to Hold Orders"
        body={`${data.user.email ?? "This account"} isn't set up for Hold Orders. Ask Josh to add you.`}
      />
    );
  }

  return (
    <div className="min-h-screen bg-base">
      <Header me={data} view={url.view} onView={(view) => update({ view, order: null })} />
      <main className="mx-auto max-w-6xl px-4 pb-16 pt-4 md:px-6">
        {data.shadowMode ? (
          <p className="mb-3 rounded-lg border border-accent-warning/40 bg-accent-warning/10 px-3 py-2 text-xs text-secondary">
            Shadow mode is on for this server: actions update the records but no email actually goes out.
          </p>
        ) : null}
        {url.view === "holds" ? (
          <HoldsList tab={url.tab} onTab={(tab) => update({ tab })} onOpen={(order) => update({ order })} />
        ) : url.view === "rules" ? (
          <RulesPanel
            canEdit={data.permissions.editRules}
            onOpenOrder={(order) => update({ view: "holds", order })}
            onOpenSettings={() => update({ view: "settings", order: null })}
          />
        ) : (
          // The drawer opens over Settings (it's rendered for any view).
          <SettingsPanel onOpenOrder={(order) => update({ order })} />
        )}
      </main>
      {url.order ? (
        <OrderDrawer orderId={url.order} me={data} onClose={() => update({ order: null })} />
      ) : null}
    </div>
  );
}

function Header({ me, view, onView }: { me: Me; view: View; onView: (v: View) => void }) {
  return (
    <header className="sticky top-0 z-30 border-b border-default bg-base/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 md:px-6">
        <div className="flex items-center gap-2">
          <PackageX className="size-5 text-accent-danger" aria-hidden />
          <span className="text-base font-semibold text-primary">Hold Orders</span>
        </div>
        <nav className="flex gap-1" aria-label="Sections">
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onView(v)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium",
                view === v ? "bg-elevated text-primary" : "text-secondary hover:bg-subtle hover:text-primary",
              )}
              aria-current={view === v ? "page" : undefined}
            >
              {VIEW_LABELS[v]}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs text-muted">
          <span className="hidden sm:inline">{me.user?.email}</span>
          <span className="rounded-full bg-elevated px-2 py-0.5 text-secondary">{me.role === "admin" ? "Admin" : "Sales"}</span>
          <a href={me.hubUrl} className="inline-flex items-center gap-1 hover:text-primary" target="_top">
            Hub <ExternalLink className="size-3" aria-hidden />
          </a>
        </div>
      </div>
    </header>
  );
}

function Centered({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-default bg-subtle p-6">
        <h1 className="mb-2 text-base font-semibold text-primary">{title}</h1>
        <p className="mb-4 text-sm text-secondary">{body}</p>
        {children}
      </div>
    </div>
  );
}

function SignIn({ hubUrl }: { hubUrl: string }) {
  return (
    <Centered
      title="Sign in via the hub"
      body="Hold Orders doesn't have its own sign-in. Open it from the Feldart hub and you'll be signed in automatically."
    >
      <a
        href={hubUrl}
        target="_top"
        className="inline-flex h-9 items-center rounded-md bg-accent-primary px-4 text-sm font-medium text-white hover:opacity-90"
      >
        Go to the hub
      </a>
    </Centered>
  );
}
