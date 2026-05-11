// Photo upload zone with drag-drop + thumbnail gallery.
// Used on damage RMA create form (when draft is saved) and detail page.

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Image, Upload, X } from "lucide-react";
import { Card, CardBody, CardHeader } from "./ui/card";

// ---- Types ------------------------------------------------------------------

type RmaPhoto = {
  id: string;
  rmaId: string;
  position: number;
  driveFileId: string;
  driveViewUrl: string;
  driveThumbnailUrl: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedByUserId: string;
  uploadedAt: string;
};

type PhotosResponse = { photos: RmaPhoto[] };

// ---- Props ------------------------------------------------------------------

type PhotoUploadZoneProps = {
  /** When null, show "Save draft first" placeholder — no uploads allowed. */
  rmaId: string | null;
};

// ---- Component --------------------------------------------------------------

export function PhotoUploadZone({ rmaId }: PhotoUploadZoneProps) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Drag-over highlight state
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  // Per-file uploading state: map from a local key → error message (or null
  // while still uploading). We keep a counter to generate unique keys.
  const [uploadingFiles, setUploadingFiles] = useState<
    Map<number, { name: string; error: string | null }>
  >(new Map());
  const uploadKeyRef = useRef(0);

  // ---- Fetch existing photos ------------------------------------------------

  const photosQuery = useQuery<RmaPhoto[]>({
    enabled: !!rmaId,
    queryKey: ["rma-photos", rmaId],
    queryFn: async () => {
      const res = await fetch(`/api/rmas/${rmaId!}/photos`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as PhotosResponse;
      return body.photos;
    },
    staleTime: 30_000,
  });

  const photos = photosQuery.data ?? [];

  // ---- Delete mutation ------------------------------------------------------

  const deleteMutation = useMutation({
    mutationFn: async (photoId: string) => {
      const res = await fetch(`/api/rmas/${rmaId!}/photos/${photoId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["rma-photos", rmaId] });
    },
  });

  // ---- Upload handler -------------------------------------------------------

  async function handleFiles(files: File[]) {
    if (!rmaId || files.length === 0) return;

    for (const file of files) {
      const key = ++uploadKeyRef.current;

      setUploadingFiles((prev) => {
        const next = new Map(prev);
        next.set(key, { name: file.name, error: null });
        return next;
      });

      // Async IIFE so all files start concurrently
      void (async () => {
        try {
          const fd = new FormData();
          fd.append("file", file);
          const res = await fetch(`/api/rmas/${rmaId}/photos`, {
            method: "POST",
            body: fd,
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as {
              error?: string;
            };
            throw new Error(body.error ?? `HTTP ${res.status}`);
          }
          // Success — remove from uploading map and refresh gallery
          setUploadingFiles((prev) => {
            const next = new Map(prev);
            next.delete(key);
            return next;
          });
          void queryClient.invalidateQueries({
            queryKey: ["rma-photos", rmaId],
          });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Upload failed";
          setUploadingFiles((prev) => {
            const next = new Map(prev);
            const entry = next.get(key);
            if (entry) next.set(key, { ...entry, error: message });
            return next;
          });
        }
      })();
    }
  }

  // ---- Drag handlers --------------------------------------------------------

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDraggingOver(true);
  }

  function onDragLeave(e: React.DragEvent) {
    // Only clear when the pointer actually leaves the zone element, not a
    // child — relatedTarget is the element being entered.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setIsDraggingOver(false);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDraggingOver(false);
    const files = Array.from(e.dataTransfer.files);
    void handleFiles(files);
  }

  // ---- Null state -----------------------------------------------------------

  if (!rmaId) {
    return (
      <Card>
        <CardHeader>
          <h2 className="text-sm font-medium">Photos</h2>
        </CardHeader>
        <CardBody>
          <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-default px-6 py-8 text-center">
            <Image className="size-8 text-muted" />
            <p className="text-sm text-muted">
              Save the RMA as a draft first to upload photos.
            </p>
          </div>
        </CardBody>
      </Card>
    );
  }

  // ---- Active state ---------------------------------------------------------

  const hasContent =
    photos.length > 0 || uploadingFiles.size > 0;

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-medium">Photos</h2>
      </CardHeader>
      <CardBody className="space-y-4">
        {/* Drop zone */}
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload photos — drag and drop or click to select"
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          className={[
            "flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-6 py-6 text-center transition-colors select-none",
            isDraggingOver
              ? "border-accent-primary bg-accent-primary/5 text-accent-primary"
              : "border-default text-muted hover:border-strong hover:text-secondary",
          ].join(" ")}
        >
          <Upload className="size-6" />
          <span className="text-sm">
            {isDraggingOver
              ? "Drop to upload"
              : "Drop images here or click to select"}
          </span>
        </div>

        {/* Hidden file input */}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            // Snapshot the file list BEFORE clearing the input — `files` is a
            // live reference; resetting `value` empties it.
            const files = e.target.files
              ? Array.from(e.target.files)
              : [];
            // Reset value so picking the same file twice fires the event
            e.target.value = "";
            void handleFiles(files);
          }}
        />

        {/* In-progress uploads and their errors */}
        {uploadingFiles.size > 0 && (
          <div className="space-y-1">
            {Array.from(uploadingFiles.entries()).map(
              ([key, { name, error }]) => (
                <div
                  key={key}
                  className={[
                    "flex items-center justify-between rounded-md px-3 py-2 text-xs",
                    error
                      ? "border border-accent-danger/30 bg-accent-danger/10 text-accent-danger"
                      : "border border-default bg-elevated text-secondary",
                  ].join(" ")}
                >
                  <span className="truncate">
                    {error ? `Upload failed: ${error}` : `Uploading ${name}…`}
                  </span>
                  {error && (
                    <button
                      type="button"
                      onClick={() =>
                        setUploadingFiles((prev) => {
                          const next = new Map(prev);
                          next.delete(key);
                          return next;
                        })
                      }
                      className="ml-2 shrink-0 text-accent-danger/70 hover:text-accent-danger"
                      aria-label="Dismiss error"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
              ),
            )}
          </div>
        )}

        {/* Thumbnail gallery */}
        {hasContent && photos.length > 0 && (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
            {photos.map((photo) => (
              <PhotoThumbnail
                key={photo.id}
                photo={photo}
                onDelete={() => deleteMutation.mutate(photo.id)}
                isDeleting={deleteMutation.isPending}
              />
            ))}
          </div>
        )}

        {/* Empty state (no uploading in-flight, no existing photos) */}
        {!hasContent && (
          <p className="text-center text-xs text-muted">No photos yet.</p>
        )}
      </CardBody>
    </Card>
  );
}

// ---- Thumbnail sub-component ------------------------------------------------

function PhotoThumbnail({
  photo,
  onDelete,
  isDeleting,
}: {
  photo: RmaPhoto;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  const src = photo.driveThumbnailUrl ?? photo.driveViewUrl;

  return (
    <div className="group relative overflow-hidden rounded-md border border-default bg-elevated">
      {/* Clickable image */}
      <a
        href={photo.driveViewUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${photo.filename} in Drive`}
        className="block aspect-square"
      >
        <img
          src={src}
          alt={photo.filename}
          className="h-full w-full object-cover transition-opacity group-hover:opacity-80"
          loading="lazy"
        />
      </a>

      {/* Delete button — visible on hover */}
      <button
        type="button"
        disabled={isDeleting}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        aria-label={`Delete ${photo.filename}`}
        className={[
          "absolute right-1 top-1 rounded-full p-0.5",
          "bg-black/60 text-white opacity-0 transition-opacity",
          "group-hover:opacity-100 hover:bg-black/80",
          "disabled:cursor-not-allowed disabled:opacity-40",
        ].join(" ")}
      >
        <X className="size-3.5" />
      </button>

      {/* Filename tooltip (truncated) */}
      <div className="truncate px-1.5 py-1 text-[10px] text-muted">
        {photo.filename}
      </div>
    </div>
  );
}

export default PhotoUploadZone;
