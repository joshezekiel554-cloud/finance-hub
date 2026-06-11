import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Users,
  FileText,
  Receipt,
  CheckSquare,
  Sparkles,
  GraduationCap,
  Settings,
  AlertCircle,
  RotateCcw,
  CalendarRange,
  Bot,
  LogOut,
  Menu,
} from "lucide-react";
import { cn } from "./lib/cn";
import { NotificationBell } from "./components/notification-bell";
import { UserPill } from "./components/user-pill";
import { MobileNavDrawer, type NavItem } from "./components/mobile-nav-drawer";
import { AgentProvider, useAgent } from "./agent/agent-store";
import { AgentPanel } from "./agent/agent-panel";

const navItems: NavItem[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/customers", label: "Customers", icon: Users },
  { to: "/invoicing", label: "Today", icon: FileText },
  { to: "/chase", label: "Chase", icon: AlertCircle },
  { to: "/statements", label: "Statements", icon: Receipt },
  { to: "/tasks", label: "Tasks", icon: CheckSquare },
  { to: "/returns", label: "Returns", icon: RotateCcw },
  { to: "/seasons", label: "Seasons", icon: CalendarRange },
  { to: "/autopilot", label: "Autopilot", icon: Bot },
  { to: "/agent", label: "Agent", icon: Sparkles },
  { to: "/ai-training", label: "AI Training", icon: GraduationCap },
  { to: "/settings", label: "Settings", icon: Settings },
];

export default function App({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <AgentProvider>
      <div className="flex min-h-screen bg-base text-primary">
      {/* Desktop sidebar — unchanged */}
      <aside className="hidden w-60 shrink-0 border-r border-default bg-subtle md:flex md:flex-col">
        <div className="flex h-14 items-center gap-2 border-b border-default px-4">
          <div className="size-7 rounded-md bg-accent-primary/10 ring-1 ring-accent-primary/30" />
          <span className="text-sm font-semibold tracking-tight">Finance Hub</span>
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm text-secondary transition-colors",
                  "hover:bg-elevated hover:text-primary",
                )}
                activeProps={{
                  className: "bg-elevated text-primary font-medium",
                }}
              >
                <Icon className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-default p-3 space-y-2">
          <SignOutFooter />
          <div className="text-xs text-muted">v2.0</div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {/* Desktop top header — unchanged structure, hidden on mobile */}
        <header className="hidden h-14 items-center justify-between border-b border-default bg-base px-6 md:flex">
          <div className="text-sm font-medium text-primary">Welcome back</div>
          <div className="flex items-center gap-3">
            <AgentToggleButton />
            <NotificationBell />
            <UserPill />
          </div>
        </header>

        {/* Mobile top app bar — sticky, hamburger left, bell+user right.
            Per-page MobileAppBar components render BELOW this when a page
            wants its own title + back chevron; that bar overlays the
            children area, so this default sits behind it. To avoid the
            stacked-bars look, pages that render their own MobileAppBar
            should also `hidden`-flag the wrapper below via a portal or
            by setting their own app-bar to position: sticky which wins
            in the same scroll container. We keep this default for top-
            level routes that don't override. */}
        <header
          className={cn(
            "md:hidden sticky top-0 z-20",
            "flex h-14 items-center gap-2 px-3",
            "border-b border-default",
            "bg-base/95 backdrop-blur supports-[backdrop-filter]:bg-base/85",
          )}
        >
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setDrawerOpen(true)}
            className="-ml-1 flex h-10 w-10 items-center justify-center rounded-md text-primary hover:bg-elevated"
          >
            <Menu className="size-5" />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="size-6 shrink-0 rounded-md bg-accent-primary/10 ring-1 ring-accent-primary/30" />
            <span className="truncate text-sm font-semibold tracking-tight">
              Finance Hub
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <AgentToggleButton />
            <NotificationBell />
            <UserPill />
          </div>
        </header>

        {/* No `overflow-y-auto` here: the app is window-scrolled (outer is
            `min-h-screen`, and TanStack `ScrollRestoration` targets the
            window). A scroll-container ancestor would capture `position:
            sticky` and break in-page sticky headers (e.g. table column
            headers on Customers/Chase), so this stays `overflow: visible`. */}
        <div className="flex-1 p-4 md:p-6">{children}</div>
      </main>

        <MobileNavDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          items={navItems}
          footer={<SignOutFooter />}
        />
        <AgentPanel />
      </div>
    </AgentProvider>
  );
}

// Header sparkles button — opens the agent overlay (Ctrl/Cmd+K works
// anywhere). Hidden on /agent where the conversation is docked.
function AgentToggleButton() {
  const { togglePanel, onAgentPage } = useAgent();
  if (onAgentPage) return null;
  return (
    <button
      type="button"
      onClick={togglePanel}
      title="Agent (Ctrl+K)"
      aria-label="Toggle AI agent panel"
      className="flex h-10 w-10 items-center justify-center rounded-md text-primary hover:bg-elevated md:h-8 md:w-8"
    >
      <Sparkles className="size-5 text-accent-primary md:size-4" />
    </button>
  );
}

function SignOutFooter() {
  const [email, setEmail] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { user?: { email?: string } } | null) => {
        if (!cancelled) setEmail(data?.user?.email ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      const csrfRes = await fetch("/api/auth/csrf");
      const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
      const body = new URLSearchParams();
      body.append("csrfToken", csrfToken);
      body.append("callbackUrl", "/login");
      body.append("json", "true");
      await fetch("/api/auth/signout", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch {
      // fall through to the redirect — the cookie clear may have worked
    }
    window.location.href = "/api/auth/signin";
  }

  return (
    <div className="space-y-1.5">
      {email && (
        <div className="truncate text-[11px] text-muted" title={email}>
          {email}
        </div>
      )}
      <button
        type="button"
        onClick={handleSignOut}
        disabled={signingOut}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-secondary transition-colors",
          "hover:bg-elevated hover:text-primary",
          "disabled:opacity-50 disabled:cursor-not-allowed",
        )}
      >
        <LogOut className="size-4" />
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
