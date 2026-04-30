import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ImageOff, Upload } from "lucide-react";
import { Button } from "./ui/button";

type Props = {
  // Path on disk (returned from GET /api/app-settings) — drives the
  // visibility of the preview and the cache-bust query string.
  logoPath: string;
  // Mutation we re-run after a successful upload so the parent's
  // settings query reflects the new disk path. Distinct from the
  // built-in invalidation here because the parent owns the query key.
  onUploaded: () => void;
};

const ACCEPT_ATTR = "image/png,image/jpeg,image/svg+xml";

export function LogoUploader({ logoPath, onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const queryClient = useQueryClient();
  // Bust the browser's image cache after a fresh upload. We also live-
  // refetch the parent settings query (so logoPath updates) but the URL
  // is stable when the path is — this stamp forces a re-fetch even if
  // the disk filename happened to repeat.
  const [cacheBust, setCacheBust] = useState<number>(() => Date.now());
  const [error, setError] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("logo", file);
      const res = await fetch("/api/logo-upload", {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as { ok: true; path: string; url: string };
    },
    onSuccess: () => {
      setError(null);
      setCacheBust(Date.now());
      queryClient.invalidateQueries({ queryKey: ["app-settings"] });
      onUploaded();
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  function pickFile() {
    inputRef.current?.click();
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input value so picking the same file twice still fires
    // a change event.
    e.target.value = "";
    if (!file) return;
    setError(null);
    upload.mutate(file);
  }

  const previewUrl = logoPath ? `/api/static/logo?cb=${cacheBust}` : null;

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-3">
        <div className="flex h-20 w-32 items-center justify-center overflow-hidden rounded-md border border-default bg-base">
          {previewUrl ? (
            <img
              src={previewUrl}
              alt="Company logo"
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <div className="flex flex-col items-center gap-1 text-muted">
              <ImageOff className="size-5" />
              <span className="text-[10px]">No logo</span>
            </div>
          )}
        </div>
        <div className="space-y-1.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={pickFile}
            disabled={upload.isPending}
          >
            <Upload className="size-3.5" />
            {upload.isPending ? "Uploading…" : "Upload logo"}
          </Button>
          <p className="text-xs text-muted">
            PNG, JPEG, or SVG. Max 2 MB.
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTR}
          onChange={onFileChange}
          className="hidden"
        />
      </div>
      {error && (
        <p className="text-xs text-accent-danger">{error}</p>
      )}
    </div>
  );
}

export default LogoUploader;
