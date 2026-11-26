import { termsLine } from "../../modules/hold-orders/terms";

/** Read-only terms line; amber "Terms not set" when finance has none. */
export function TermsText({
  terms,
  rule,
  className = "",
  financeUrl,
}: {
  terms: string | null;
  rule: { preset: string; graceDays: number } | null;
  className?: string;
  financeUrl?: string | null;
}) {
  const t = termsLine(terms, rule);
  if (t.known) return <div className={`text-secondary ${className}`}>{t.text}</div>;
  return (
    <div className={`text-accent-warning ${className}`}>
      {t.text}
      {" — "}
      {financeUrl ? (
        <a href={financeUrl} target="_top" className="font-medium underline">
          set them on the finance customer page
        </a>
      ) : (
        "set on the finance customer page"
      )}
    </div>
  );
}
