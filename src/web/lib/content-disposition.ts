// Read the download filename out of a Content-Disposition header.
// Prefers the RFC 5987 `filename*=UTF-8''…` form (exact name, incl.
// non-ASCII) and falls back to the quoted `filename="…"` form.
export function filenameFromContentDisposition(
  header: string | null,
  fallback: string,
): string {
  if (!header) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // Malformed escape — fall through to the plain form.
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain?.[1] ?? fallback;
}
