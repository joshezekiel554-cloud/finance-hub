// Embedded-in-hub mode for the finance SPA (hub phase-1 spec §5).
//
// The server sets `hub_embedded=1` when the user arrives via /auth/hub?hub=1.
// While present (and we really are in a frame) the app hides its own top
// bar — the hub's chrome replaces it — and reports client-side navigation
// to the parent so the hub can mirror our URL.

export type HubNavigateMessage = { type: "hub:navigate"; path: string };
export type HubUnauthenticatedMessage = { type: "hub:unauthenticated" };

export function parseHubEmbeddedCookie(cookie: string | undefined): boolean {
  if (!cookie) return false;
  return cookie.split(";").some((c) => c.trim() === "hub_embedded=1");
}

export function hubNavigateMessage(path: string): HubNavigateMessage {
  return { type: "hub:navigate", path };
}

/** True when this document is inside any iframe. */
export function isFramed(): boolean {
  try {
    return typeof window !== "undefined" && window.self !== window.top;
  } catch {
    // Cross-origin parent throws on window.top access in some browsers —
    // which itself means we are framed.
    return true;
  }
}

/**
 * Embedded chrome mode: framed AND arrived via the hub handoff. The cookie
 * alone is not enough (a later top-level visit would lose the nav), and
 * framing alone is not enough (we'd hide chrome for any parent).
 */
export function isHubEmbedded(): boolean {
  if (typeof document === "undefined") return false;
  return isFramed() && parseHubEmbeddedCookie(document.cookie);
}

// The parent is hub.feldart.com in production; the message carries only a
// path (nothing secret), so a wildcard target origin is acceptable and
// avoids hard-coding the hub origin into the client bundle.
function postToParent(message: HubNavigateMessage | HubUnauthenticatedMessage): void {
  if (typeof window === "undefined" || window.parent === window) return;
  window.parent.postMessage(message, "*");
}

export function postHubNavigate(path: string): void {
  postToParent(hubNavigateMessage(path));
}

export function postHubUnauthenticated(): void {
  postToParent({ type: "hub:unauthenticated" });
}
