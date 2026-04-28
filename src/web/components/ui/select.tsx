import { forwardRef, useId, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/cn";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ id, label, error, helperText, className, children, ...rest }, ref) => {
    const reactId = useId();
    const selectId = id ?? reactId;
    const helperId = `${selectId}-helper`;
    const errorId = `${selectId}-error`;

    return (
      <div className="flex flex-col gap-1.5">
        {label ? (
          <label htmlFor={selectId} className="text-sm font-medium text-primary">
            {label}
          </label>
        ) : null}
        <div className="relative">
          <select
            ref={ref}
            id={selectId}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : helperText ? helperId : undefined}
            className={cn(
              "h-9 w-full appearance-none rounded-md border bg-base pl-3 pr-9 text-sm text-primary",
              "focus:outline-none focus:ring-2 focus:ring-accent-primary/40",
              "disabled:cursor-not-allowed disabled:opacity-60",
              error ? "border-accent-danger" : "border-default focus:border-strong",
              className,
            )}
            {...rest}
          >
            {children}
          </select>
          <ChevronDown
            aria-hidden
            className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted"
          />
        </div>
        {error ? (
          <p id={errorId} className="text-xs text-accent-danger">
            {error}
          </p>
        ) : helperText ? (
          <p id={helperId} className="text-xs text-muted">
            {helperText}
          </p>
        ) : null}
      </div>
    );
  },
);
Select.displayName = "Select";
