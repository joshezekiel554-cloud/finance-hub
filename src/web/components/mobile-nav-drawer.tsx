// Left-slide-in nav drawer for phones. Reuses the same nav items as the
// desktop sidebar (single source of truth in App.tsx) — those are passed
// in so this component stays presentational and we don't duplicate the
// list across files.

import { useEffect } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Link, useRouterState } from "@tanstack/react-router";
import { type LucideIcon, X } from "lucide-react";
import { cn } from "../lib/cn";

export type NavItem = { to: string; label: string; icon: LucideIcon };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: NavItem[];
  footer?: React.ReactNode;
};

export function MobileNavDrawer({ open, onOpenChange, items, footer }: Props) {
  // Auto-close the drawer when the route changes — tapping a nav item
  // navigates, the route updates, the drawer dismisses. Listening on
  // pathname rather than a click handler avoids subtle races with
  // TanStack Router's transition lifecycle.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    if (open) onOpenChange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-40 bg-black/45 backdrop-blur-sm",
            "ui-fade",
          )}
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            "fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw]",
            "bg-subtle border-r border-default",
            "flex flex-col",
            "focus:outline-none",
            "ui-slide-in-left",
          )}
        >
          <div className="flex h-14 items-center justify-between border-b border-default px-4">
            <div className="flex items-center gap-2">
              <div className="size-7 rounded-md bg-accent-primary/10 ring-1 ring-accent-primary/30" />
              <DialogPrimitive.Title className="text-sm font-semibold tracking-tight">
                Finance Hub
              </DialogPrimitive.Title>
            </div>
            <DialogPrimitive.Close
              aria-label="Close menu"
              className="flex size-9 items-center justify-center rounded-md text-muted hover:bg-elevated hover:text-primary"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>

          <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-3 text-sm text-secondary",
                    "hover:bg-elevated hover:text-primary",
                  )}
                  activeProps={{
                    className: "bg-elevated text-primary font-medium",
                  }}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </nav>

          {footer ? (
            <div className="border-t border-default p-3">{footer}</div>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
