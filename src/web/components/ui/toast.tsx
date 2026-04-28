import { forwardRef } from "react";
import * as ToastPrimitive from "@radix-ui/react-toast";
import { X } from "lucide-react";
import { cn } from "../../lib/cn";

export const ToastProvider = ToastPrimitive.Provider;

export const ToastViewport = forwardRef<
  HTMLOListElement,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Viewport>
>(({ className, ...rest }, ref) => (
  <ToastPrimitive.Viewport
    ref={ref}
    className={cn(
      "fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2",
      className,
    )}
    {...rest}
  />
));
ToastViewport.displayName = "ToastViewport";

type Tone = "neutral" | "success" | "danger" | "info";

const toneClass: Record<Tone, string> = {
  neutral: "border-default bg-subtle text-primary",
  success: "border-accent-success/40 bg-subtle text-primary",
  danger: "border-accent-danger/40 bg-subtle text-primary",
  info: "border-accent-info/40 bg-subtle text-primary",
};

export interface ToastProps
  extends React.ComponentPropsWithoutRef<typeof ToastPrimitive.Root> {
  tone?: Tone;
}

export const Toast = forwardRef<
  React.ComponentRef<typeof ToastPrimitive.Root>,
  ToastProps
>(({ className, tone = "neutral", ...rest }, ref) => (
  <ToastPrimitive.Root
    ref={ref}
    className={cn(
      "rounded-lg border px-4 py-3 shadow-md",
      "data-[state=open]:animate-in data-[state=closed]:animate-out",
      "data-[state=closed]:fade-out-0 data-[state=open]:slide-in-from-right-4",
      toneClass[tone],
      className,
    )}
    {...rest}
  />
));
Toast.displayName = "Toast";

export const ToastTitle = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Title>
>(({ className, ...rest }, ref) => (
  <ToastPrimitive.Title
    ref={ref}
    className={cn("text-sm font-semibold", className)}
    {...rest}
  />
));
ToastTitle.displayName = "ToastTitle";

export const ToastDescription = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Description>
>(({ className, ...rest }, ref) => (
  <ToastPrimitive.Description
    ref={ref}
    className={cn("mt-1 text-xs text-secondary", className)}
    {...rest}
  />
));
ToastDescription.displayName = "ToastDescription";

export const ToastClose = forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Close>
>(({ className, ...rest }, ref) => (
  <ToastPrimitive.Close
    ref={ref}
    aria-label="Close"
    className={cn(
      "absolute right-2 top-2 rounded-sm p-1 text-muted hover:bg-elevated hover:text-primary",
      className,
    )}
    {...rest}
  >
    <X className="size-3.5" />
  </ToastPrimitive.Close>
));
ToastClose.displayName = "ToastClose";
