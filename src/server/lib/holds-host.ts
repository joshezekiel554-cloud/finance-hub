// Hold Orders host routing (pure apart from the env default).
// holdorders.feldart.com is served by this same Fastify process; these
// decide which requests on that host get the Hold Orders SPA shell.

import { env } from "../../lib/env.js";

/** Bare host (no port), lowercased. */
export function bareHost(host: string | undefined | null): string {
  return (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
}

export function isHoldsHost(
  host: string | undefined | null,
  holdsHost: string = env.HOLDORDERS_HOST,
): boolean {
  const h = bareHost(host);
  return h !== "" && h === holdsHost;
}

/**
 * On the holdorders host, which GET paths get the Hold Orders SPA shell?
 * Everything that isn't an API/auth/oauth route or a real static asset
 * (anything with a file extension other than .html — /assets/x.js etc.).
 */
export function servesHoldsSpa(url: string): boolean {
  const path = (url.split("?")[0] ?? "/").split("#")[0] ?? "/";
  if (path.startsWith("/api") || path.startsWith("/auth") || path.startsWith("/oauth")) return false;
  if (path === "/health") return false;
  const last = path.split("/").pop() ?? "";
  if (last.includes(".") && !last.endsWith(".html")) return false;
  return true;
}
