// Inline audio player. Fetches a fresh signed URL on mount because the
// Vocatech-hosted media URL expires (30 min); a stale URL across navigations
// would 403 mid-playback, so we always re-mint.

import { useEffect, useState } from "react";

type Props = { phoneCommId: string };

export function CallRecordingPlayer({ phoneCommId }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setError(null);
    fetch(`/api/vocatech/recording-url/${phoneCommId}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<{ url: string }>;
      })
      .then((data) => {
        if (!cancelled) setUrl(data.url);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load recording");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [phoneCommId]);

  if (error) return <span className="text-xs text-accent-danger">{error}</span>;
  if (!url) return <span className="text-xs text-muted">Loading recording…</span>;
  return <audio controls src={url} className="h-8 w-full max-w-md" />;
}
