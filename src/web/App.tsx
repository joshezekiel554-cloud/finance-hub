import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Users,
  FileText,
  Receipt,
  CheckSquare,
  Sparkles,
  Settings,
  AlertCircle,
  RotateCcw,
  CalendarRange,
  LogOut,
} from "lucide-react";
import { cn } from "./lib/cn";
import { NotificationBell } from "./components/notification-bell";

const navItems = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/customers", label: "Customers", icon: Users },
  { to: "/invoicing", label: "Invoicing", icon: FileText },
  { to: "/chase", label: "Chase", icon: AlertCircle },
  { to: "/statements", label: "Statements", icon: Receipt },
  { to: "/tasks", label: "Tasks", icon: CheckSquare },
  { to: "/returns", label: "Returns", icon: RotateCcw },
  { to: "/seasons", label: "Seasons", icon: CalendarRange },
  { to: "/agent", label: "Agent", icon: Sparkles },
  { to: "/settings", label: "Settings", icon: Settings },
];

export default function App({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-base text-primary">
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

      <main className="flex flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-default bg-base px-4 md:px-6">
          <div className="text-sm font-medium text-primary">Welcome back</div>
          <NotificationBell />
        </header>
        <div className="flex-1 overflow-y-auto p-4 md:p-6">{children}</div>
      </main>
    </div>
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
      const form = new FormData();
      form.append("csrfToken", csrfToken);
      form.append("callbackUrl", "/login");
      await fetch("/api/auth/signout", { method: "POST", body: form });
    } catch {
      // fall through to the redirect — the cookie clear may have worked
    }
    window.location.href = "/login";
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
