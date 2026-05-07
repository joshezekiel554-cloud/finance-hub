// ReturnReceiptCard — collapsible card rendering a single warehouse
// return-receipt email. Used in two contexts:
//
//   1. Today tab (Task 2.2) — interactive mode: onDismiss is provided,
//      three dismiss action buttons appear.
//   2. RMA detail / ProcessReturnPanel (Task 3.1) — read-only mode:
//      onDismiss is undefined, no dismiss buttons rendered.
//
// Body sanitization mirrors the outbound-email allow-list in
// src/server/routes/email-send.ts so the same trusted tag set is used
// on both sides of the email pipeline.

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import sanitizeHtml from "sanitize-html";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardBody } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReturnReceiptCardProps = {
  receipt: {
    receiptId: string;
    gmailMessageId: string;
    emailSubject: string;
    emailFrom: string;
    emailBodyHtml?: string | null;
    emailBodyText?: string | null;
    classifiedAt: string;
  };
  linkedRmas: Array<{
    rmaId: string;
    rmaNumber: string | null;
    customerName: string | null;
  }>;
  onDismiss?: (
    reason: "done" | "not_return" | "other",
    reasonText?: string,
  ) => void;
  defaultExpanded?: boolean;
};

// ---------------------------------------------------------------------------
// sanitize-html config — mirrors HTML_SANITIZE_OPTIONS in email-send.ts
// ---------------------------------------------------------------------------

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p",
    "br",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "ul",
    "ol",
    "li",
    "blockquote",
    "a",
    "code",
    "pre",
    "hr",
    "span",
    "div",
  ],
  allowedAttributes: {
    a: ["href", "target", "rel"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {},
  allowedSchemesAppliedToAttributes: ["href"],
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...attribs,
        target: "_blank",
        rel: "noopener noreferrer",
      },
    }),
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatClassifiedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// Escape plain text for safe injection into the DOM via innerHTML —
// but we render plain text as a <pre> via React, not innerHTML, so
// this is just a safety belt in case usage changes.
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReturnReceiptCard({
  receipt,
  linkedRmas,
  onDismiss,
  defaultExpanded = false,
}: ReturnReceiptCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // "other" dismiss inline input state
  const [showOtherInput, setShowOtherInput] = useState(false);
  const [otherText, setOtherText] = useState("");

  const readOnly = onDismiss === undefined;

  // Prepare sanitized body HTML once (avoids re-sanitizing on every render).
  // Prefer HTML body; fall back to plain text in a <pre>.
  const hasHtml = Boolean(receipt.emailBodyHtml);
  const sanitizedHtml = hasHtml
    ? sanitizeHtml(receipt.emailBodyHtml!, SANITIZE_OPTIONS)
    : null;

  return (
    <Card>
      {/* ------------------------------------------------------------------ */}
      {/* Header — always visible, click to expand/collapse                   */}
      {/* ------------------------------------------------------------------ */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start justify-between gap-3 border-b border-default px-4 py-3 text-left transition-colors hover:bg-elevated/40"
        aria-expanded={expanded}
      >
        <div className="min-w-0 flex-1">
          {/* Sender + date */}
          <p className="truncate text-xs text-secondary">
            <span className="font-medium text-primary">
              {receipt.emailFrom}
            </span>
            <span className="mx-1.5 text-muted">·</span>
            <span>{formatClassifiedAt(receipt.classifiedAt)}</span>
          </p>
          {/* Subject */}
          <p className="mt-0.5 truncate text-sm font-semibold text-primary">
            {receipt.emailSubject}
          </p>
        </div>
        <span className="mt-0.5 shrink-0 text-muted">
          {expanded ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </span>
      </button>

      {/* ------------------------------------------------------------------ */}
      {/* Expanded body                                                        */}
      {/* ------------------------------------------------------------------ */}
      {expanded && (
        <CardBody className="border-b border-default">
          {sanitizedHtml ? (
            <div
              className="prose prose-sm max-w-none text-primary"
              // sanitizeHtml has already stripped dangerous markup.
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
            />
          ) : receipt.emailBodyText ? (
            <pre className="whitespace-pre-wrap break-words text-sm text-primary">
              {escapeHtml(receipt.emailBodyText)}
            </pre>
          ) : (
            <p className="text-sm text-muted">(No email body)</p>
          )}
        </CardBody>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Footer — linked RMA badges + (interactive only) dismiss actions      */}
      {/* ------------------------------------------------------------------ */}
      <div className="px-4 py-3 space-y-3">
        {/* RMA badges */}
        <div className="flex flex-wrap items-center gap-1.5">
          {linkedRmas.length > 0 ? (
            linkedRmas.map((rma) => (
              <Link
                key={rma.rmaId}
                to="/returns/$rmaId"
                params={{ rmaId: rma.rmaId }}
                className="no-underline"
              >
                <Badge tone="info">
                  {rma.rmaNumber ?? rma.rmaId}
                  {rma.customerName ? ` · ${rma.customerName}` : ""}
                </Badge>
              </Link>
            ))
          ) : (
            <span className="text-xs text-muted">No linked RMA</span>
          )}
        </div>

        {/* Dismiss actions — only in interactive mode */}
        {!readOnly && onDismiss && (
          <div className="flex flex-wrap items-center gap-2">
            {!showOtherInput ? (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => onDismiss("done")}
                >
                  Dismiss — done
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onDismiss("not_return")}
                >
                  Dismiss — not return
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowOtherInput(true);
                    setOtherText("");
                  }}
                >
                  Dismiss — other
                </Button>
              </>
            ) : (
              /* Inline reason input for "other" */
              <div className="flex w-full flex-wrap items-center gap-2">
                <Input
                  value={otherText}
                  onChange={(e) => setOtherText(e.target.value)}
                  placeholder="Reason (optional)"
                  maxLength={50}
                  className="min-w-0 flex-1"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onDismiss("other", otherText.trim() || undefined);
                    } else if (e.key === "Escape") {
                      setShowOtherInput(false);
                      setOtherText("");
                    }
                  }}
                />
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() =>
                    onDismiss("other", otherText.trim() || undefined)
                  }
                >
                  Save
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowOtherInput(false);
                    setOtherText("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
