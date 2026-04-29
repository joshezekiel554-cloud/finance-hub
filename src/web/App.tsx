import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Users,
  FileText,
  CheckSquare,
  Sparkles,
  Bell,
  Settings,
} from "lucide-react";
import { cn } from "./lib/cn";

const navItems = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/customers", label: "Customers", icon: Users },
  { to: "/invoicing", label: "Invoicing", icon: FileText },
  { to: "/tasks", label: "Tasks", icon: CheckSquare },
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
        <div className="border-t border-default p-3 text-xs text-muted">v2.0</div>
      </aside>

      <main className="flex flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-default bg-base px-4 md:px-6">
          <div className="text-sm font-medium text-primary">Welcome back</div>
          <button
            type="button"
            aria-label="Notifications"
            className="rounded-md p-2 text-secondary hover:bg-elevated hover:text-primary"
          >
            <Bell className="size-4" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4 md:p-6">{children}</div>
      </main>
    </div>
  );
}
