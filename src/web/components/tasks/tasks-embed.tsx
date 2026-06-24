// Shared tasks board EMBED — the reusable iframe that renders the inbox global
// tasks board, scoped to the logged-in finance user via a short-lived token
// minted by `GET /api/tasks/embed-url`. Used by:
//   - the /shared-tasks page (whole-team board)
//   - the customer-detail Tasks tab (pass `customerId` to scope to one customer)
//
// TWO MODES (shared-tasks M6):
//   "view" — read-only embed, 5-min token, RE-MINTED every ~4 min + on focus so
//            a long-open tab never holds a dead token (the iframe reloads on each
//            re-mint; harmless for a read-only board).
//   "edit" — INTERACTIVE embed (open a task + edit core fields + drag-restatus),
//            30-min `scope:"edit"` token, minted ONCE on mount with NO periodic
//            reload — a re-mint mid-edit would blow away the open editor/drag.
//            Past 30 min idle the embed shows its own soft "session expired —
//            reopen" (inbox-side); navigating back here remounts a fresh token.
//
// postMessage token-refresh handshake (shared-tasks M6). The interactive (edit)
// embed rides a 30-min token; when it nears expiry / a write 401s, the inbox
// embed asks its parent (us) for a fresh edit token so the session continues
// WITHOUT reloading the iframe (which would discard an open editor/drag). The
// message shape + origin discipline are the LOCKED contract with inbox:
//   embed → parent : { type: "feldart-tasks:need-token" }
//   parent → embed : { type: "feldart-tasks:token", vt: "<fresh edit token>" }
// SECURITY: we ONLY honour a need-token whose event.origin === the inbox embed
// origin AND whose event.source === our own iframe's contentWindow, and we reply
// with targetOrigin = that exact inbox origin (never "*").

import { useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { Card, CardBody } from "../ui/card";
import { Button } from "../ui/button";

const NEED_TOKEN_MSG = "feldart-tasks:need-token";
const TOKEN_MSG = "feldart-tasks:token";

type EmbedUrlResponse = { url: string; mode?: "view" | "edit" };

async function fetchEmbedUrl(
  mode: "view" | "edit",
  customerId?: string,
): Promise<EmbedUrlResponse> {
  const params = new URLSearchParams();
  if (mode === "edit") params.set("mode", "edit");
  if (customerId) params.set("customer", customerId);
  const qs = params.toString();
  const res = await fetch(`/api/tasks/embed-url${qs ? `?${qs}` : ""}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/** Origin of the embed URL (the inbox app), or null if it can't be parsed. */
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url, window.location.origin).origin;
  } catch {
    return null;
  }
}

/** Pull the `vt` token out of a freshly-minted embed URL. */
function vtOf(url: string): string | null {
  try {
    return new URL(url, window.location.origin).searchParams.get("vt");
  } catch {
    return null;
  }
}

/**
 * The security gate for the token-refresh handshake (M6): is this incoming
 * message a genuine `need-token` request from OUR embed iframe? Returns true
 * only when ALL of these hold:
 *   - the message origin is EXACTLY the inbox embed origin,
 *   - the message source is OUR iframe's contentWindow (not another frame/popup),
 *   - the payload type is exactly `feldart-tasks:need-token`.
 * Pure (no React/DOM mutation) so the boundary can be unit-tested directly.
 */
export function isTokenRefreshRequest(
  ev: Pick<MessageEvent, "origin" | "source" | "data">,
  embedOrigin: string | null,
  frameWindow: Window | null | undefined,
): boolean {
  if (!embedOrigin) return false;
  if (ev.origin !== embedOrigin) return false;
  if (!frameWindow || ev.source !== frameWindow) return false;
  const msg = ev.data as { type?: unknown } | null;
  return !!msg && msg.type === NEED_TOKEN_MSG;
}

export type TasksEmbedHandle = {
  /** Re-mint the embed URL (e.g. after creating a task on the board). */
  refetch: () => void;
  isPending: boolean;
};

/**
 * Renders the inbox tasks board in an iframe. `mode` defaults to "edit" (the
 * interactive embed). Pass `customerId` to scope the board to one finance
 * customer (the Tasks tab). `onReady` hands the parent a {refetch} handle so a
 * "New task"/"Refresh" button outside the iframe can re-mint.
 */
export function TasksEmbed({
  mode = "edit",
  customerId,
  className,
  onReady,
}: {
  mode?: "view" | "edit";
  customerId?: string;
  className?: string;
  onReady?: (handle: TasksEmbedHandle) => void;
}) {
  const isEdit = mode === "edit";
  const { data, isPending, isError, error, refetch } = useQuery<EmbedUrlResponse>({
    queryKey: ["tasks", "embed-url", mode, customerId ?? null],
    queryFn: () => fetchEmbedUrl(mode, customerId),
    // VIEW: 5-min token → refresh comfortably inside that window. EDIT: mint once
    // (30-min token) — no periodic refetch, so an edit session is never reloaded.
    staleTime: isEdit ? Infinity : 4 * 60_000,
    refetchInterval: isEdit ? false : 4 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  // Hand the parent a stable-ish handle so its own buttons can re-mint.
  useEffect(() => {
    onReady?.({ refetch: () => void refetch(), isPending });
  }, [onReady, refetch, isPending]);

  // Re-mint on window focus so a returning tab is never holding a dead token —
  // VIEW mode only. In EDIT mode we deliberately DON'T re-mint on focus: a reload
  // would discard an in-progress edit/drag (a 30-min token + inbox's soft-expiry
  // covers the idle case instead).
  const onFocus = useCallback(() => {
    if (!isEdit) void refetch();
  }, [isEdit, refetch]);
  useEffect(() => {
    if (isEdit) return;
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [isEdit, onFocus]);

  // EDIT-mode token-refresh responder (M6). Listens for the inbox embed's
  // `need-token` request and replies with a freshly-minted edit token, so a long
  // editing session never reloads the iframe. Strictly origin- + source-gated.
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const mintingRef = useRef(false);
  const embedOrigin = originOf(data?.url);
  useEffect(() => {
    if (!isEdit || !embedOrigin) return;

    async function onMessage(ev: MessageEvent) {
      const frameWin = iframeRef.current?.contentWindow;
      // Strict origin + source + type gate (see isTokenRefreshRequest). The
      // extra null checks are redundant with the gate but narrow the types for
      // the postMessage reply below.
      if (!isTokenRefreshRequest(ev, embedOrigin, frameWin) || !frameWin || !embedOrigin)
        return;
      // Coalesce a burst of requests into one mint.
      if (mintingRef.current) return;
      mintingRef.current = true;
      try {
        const fresh = await fetchEmbedUrl("edit", customerId);
        const vt = vtOf(fresh.url);
        if (vt) {
          // Reply ONLY to the inbox embed origin — never "*".
          frameWin.postMessage({ type: TOKEN_MSG, vt }, embedOrigin);
        }
      } catch {
        // Mint failed — stay silent; the embed falls back to its soft-expiry
        // notice. Nothing to surface in the parent chrome.
      } finally {
        mintingRef.current = false;
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [isEdit, embedOrigin, customerId]);

  if (isPending) {
    return <div className={className ?? "flex-1 animate-pulse rounded-lg bg-subtle"} />;
  }
  if (isError) {
    return (
      <Card className="border-accent-danger/40 bg-accent-danger/5">
        <CardBody>
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-accent-danger" />
            <div className="flex-1">
              <div className="text-sm font-medium text-primary">
                Tasks board temporarily unavailable
              </div>
              <div className="mt-0.5 text-xs text-secondary">
                {(error as Error)?.message === "tasks_not_configured"
                  ? "Shared tasks isn't configured yet on this server."
                  : "Couldn't reach the tasks service. Try again in a moment."}
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  }
  return (
    <iframe
      ref={iframeRef}
      // key on the URL: reloads with the freshly-minted token when it changes.
      // In EDIT mode the URL is minted once (stable) so the frame never
      // reloads; the token-refresh handshake keeps the session alive instead.
      key={data!.url}
      src={data!.url}
      title="Shared tasks board"
      className={
        className ?? "min-h-0 flex-1 rounded-lg border border-default bg-base"
      }
    />
  );
}
