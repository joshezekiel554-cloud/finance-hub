import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

type Props = {
  title: string;
  count?: number;
  link?: string;
  linkLabel?: string;
};

export function WidgetHeader({
  title,
  count,
  link,
  linkLabel = "See all",
}: Props) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-medium text-primary">{title}</h2>
        {typeof count === "number" && (
          <span className="text-xs text-muted">{count}</span>
        )}
      </div>
      {link && (
        <Link
          to={link}
          className="inline-flex items-center gap-0.5 text-xs text-secondary hover:text-primary"
        >
          {linkLabel}
          <ArrowRight className="size-3" />
        </Link>
      )}
    </div>
  );
}
