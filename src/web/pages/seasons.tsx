// /seasons — Settings page for managing seasonal product lists.
// Lists all seasons (active first, archived after). Each season can be
// expanded to show SeasonProductsManager. New seasons created inline.
// Archived seasons can be duplicated with new name+dates.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Copy, Plus, AlertCircle, Pencil, Trash2 } from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import SeasonProductsManager from "../components/season-products-manager";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";

type Season = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
  productCount?: number;
};

type SeasonsResponse = { seasons: Season[] };

// ---- Page -------------------------------------------------------------------

export default function SeasonsPage() {
  const queryClient = useQueryClient();
  const { data, isPending, isError } = useQuery<SeasonsResponse>({
    queryKey: ["seasons"],
    queryFn: async () => {
      const res = await fetch("/api/seasons");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });

  const seasons = data?.seasons ?? [];
  const activeSeasons = seasons.filter((s) => s.isActive);
  const archivedSeasons = seasons.filter((s) => !s.isActive);

  // Expanded season state
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // New season modal
  const [newSeasonOpen, setNewSeasonOpen] = useState(false);

  // Duplicate modal
  const [duplicateTarget, setDuplicateTarget] = useState<Season | null>(null);

  // Edit modal
  const [editTarget, setEditTarget] = useState<Season | null>(null);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<Season | null>(null);

  const deleteMutation = useMutation<unknown, Error, string>({
    mutationFn: async (id) => {
      const res = await fetch(`/api/seasons/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      setDeleteTarget(null);
      queryClient.invalidateQueries({ queryKey: ["seasons"] });
    },
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Seasons &amp; seasonal products</h1>
          <p className="mt-1 text-sm text-secondary">
            Manage seasons and their associated product lists. Products marked as
            seasonal count toward cumulative return thresholds.
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setNewSeasonOpen(true)}
        >
          <Plus className="size-3.5" />
          New season
        </Button>
      </div>

      {isPending && (
        <div className="py-10 text-center text-sm text-muted">Loading seasons…</div>
      )}
      {isError && (
        <div className="flex items-center gap-2 rounded-md border border-accent-danger/30 bg-accent-danger/10 px-4 py-3 text-sm text-accent-danger">
          <AlertCircle className="size-4 shrink-0" />
          Failed to load seasons
        </div>
      )}

      {/* Active seasons */}
      {activeSeasons.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-primary">Active seasons</h2>
          {activeSeasons.map((season) => (
            <SeasonCard
              key={season.id}
              season={season}
              expanded={expandedId === season.id}
              onToggle={() => setExpandedId(expandedId === season.id ? null : season.id)}
              onEdit={() => setEditTarget(season)}
              onDelete={() => setDeleteTarget(season)}
              onDuplicate={null}
            />
          ))}
        </div>
      )}

      {/* Archived seasons */}
      {archivedSeasons.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-primary">Archived seasons</h2>
          {archivedSeasons.map((season) => (
            <SeasonCard
              key={season.id}
              season={season}
              expanded={expandedId === season.id}
              onToggle={() => setExpandedId(expandedId === season.id ? null : season.id)}
              onEdit={() => setEditTarget(season)}
              onDelete={() => setDeleteTarget(season)}
              onDuplicate={() => setDuplicateTarget(season)}
            />
          ))}
        </div>
      )}

      {!isPending && !isError && seasons.length === 0 && (
        <div className="rounded-md border border-default bg-subtle px-4 py-8 text-center">
          <p className="text-sm text-muted">No seasons created yet.</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => setNewSeasonOpen(true)}
          >
            <Plus className="size-3.5" />
            Create first season
          </Button>
        </div>
      )}

      {/* New season dialog */}
      <NewSeasonDialog
        open={newSeasonOpen}
        onOpenChange={setNewSeasonOpen}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ["seasons"] })}
      />

      {/* Duplicate dialog */}
      {duplicateTarget && (
        <DuplicateSeasonDialog
          season={duplicateTarget}
          open={!!duplicateTarget}
          onOpenChange={(open) => { if (!open) setDuplicateTarget(null); }}
          onCreated={() => queryClient.invalidateQueries({ queryKey: ["seasons"] })}
        />
      )}

      {/* Edit dialog */}
      {editTarget && (
        <EditSeasonDialog
          season={editTarget}
          open={!!editTarget}
          onOpenChange={(open) => { if (!open) setEditTarget(null); }}
          onUpdated={() => queryClient.invalidateQueries({ queryKey: ["seasons"] })}
        />
      )}

      {/* Delete confirm */}
      {deleteTarget && (
        <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete season?</DialogTitle>
              <DialogDescription>
                This will delete "{deleteTarget.name}" and all its product associations.
                This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            {deleteMutation.isError && (
              <div className="flex items-center gap-2 rounded-md border border-accent-danger/30 bg-accent-danger/10 px-3 py-2 text-sm text-accent-danger">
                <AlertCircle className="size-4 shrink-0" />
                {deleteMutation.error.message}
              </div>
            )}
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                loading={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate(deleteTarget.id)}
              >
                Delete season
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ---- Season card -------------------------------------------------------------

function SeasonCard({
  season,
  expanded,
  onToggle,
  onEdit,
  onDelete,
  onDuplicate,
}: {
  season: Season;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDuplicate: (() => void) | null;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="flex flex-1 items-center gap-3 text-left"
            onClick={onToggle}
          >
            {expanded ? (
              <ChevronUp className="size-4 shrink-0 text-muted" />
            ) : (
              <ChevronDown className="size-4 shrink-0 text-muted" />
            )}
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm">{season.name}</span>
                {season.isActive ? (
                  <Badge tone="success">Active</Badge>
                ) : (
                  <Badge tone="neutral">Archived</Badge>
                )}
                {season.productCount !== undefined && (
                  <span className="text-xs text-muted">
                    {season.productCount} product{season.productCount !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-xs text-secondary">
                {formatDate(season.startDate)} — {formatDate(season.endDate)}
              </div>
            </div>
          </button>

          {/* Action buttons */}
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              title="Edit season"
              onClick={(e) => { e.stopPropagation(); onEdit(); }}
              className="rounded p-1 text-muted hover:bg-elevated hover:text-primary"
            >
              <Pencil className="size-3.5" />
            </button>
            {onDuplicate && (
              <button
                type="button"
                title="Duplicate season"
                onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
                className="rounded p-1 text-muted hover:bg-elevated hover:text-primary"
              >
                <Copy className="size-3.5" />
              </button>
            )}
            <button
              type="button"
              title="Delete season"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="rounded p-1 text-muted hover:bg-elevated hover:text-accent-danger"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        </div>
      </CardHeader>

      {expanded && (
        <CardBody className="border-t border-default">
          <SeasonProductsManager seasonId={season.id} />
        </CardBody>
      )}
    </Card>
  );
}

// ---- New season dialog -------------------------------------------------------

function NewSeasonDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [isActive, setIsActive] = useState(true);

  const mutation = useMutation<{ season: Season }, Error, void>({
    mutationFn: async () => {
      const res = await fetch("/api/seasons", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, startDate, endDate, isActive }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      onCreated();
      onOpenChange(false);
      setName("");
      setStartDate("");
      setEndDate("");
      setIsActive(true);
    },
  });

  const canSubmit = name.trim() && startDate && endDate && !mutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New season</DialogTitle>
          <DialogDescription>
            Create a season to track seasonal product eligibility windows.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 mt-2">
          <Input
            label="Season name"
            placeholder="e.g. Spring 2026"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-primary mb-1.5">
                Start date
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="h-9 w-full rounded-md border border-default bg-base px-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/40"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-primary mb-1.5">
                End date
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="h-9 w-full rounded-md border border-default bg-base px-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/40"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="rounded"
            />
            <span className="text-sm">Mark as active season</span>
          </label>
          {mutation.isError && (
            <div className="flex items-center gap-2 text-sm text-accent-danger">
              <AlertCircle className="size-4 shrink-0" />
              {mutation.error.message}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canSubmit}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            Create season
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Edit season dialog ------------------------------------------------------

function EditSeasonDialog({
  season,
  open,
  onOpenChange,
  onUpdated,
}: {
  season: Season;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onUpdated: () => void;
}) {
  const [name, setName] = useState(season.name);
  const [startDate, setStartDate] = useState(season.startDate);
  const [endDate, setEndDate] = useState(season.endDate);
  const [isActive, setIsActive] = useState(season.isActive);

  const mutation = useMutation<{ season: Season }, Error, void>({
    mutationFn: async () => {
      const res = await fetch(`/api/seasons/${season.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, startDate, endDate, isActive }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      onUpdated();
      onOpenChange(false);
    },
  });

  const canSubmit = name.trim() && startDate && endDate && !mutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit season</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 mt-2">
          <Input
            label="Season name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-primary mb-1.5">Start date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="h-9 w-full rounded-md border border-default bg-base px-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/40"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-primary mb-1.5">End date</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="h-9 w-full rounded-md border border-default bg-base px-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/40"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="rounded"
            />
            <span className="text-sm">Active season</span>
          </label>
          {mutation.isError && (
            <div className="flex items-center gap-2 text-sm text-accent-danger">
              <AlertCircle className="size-4 shrink-0" />
              {mutation.error.message}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canSubmit}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Duplicate season dialog -------------------------------------------------

function DuplicateSeasonDialog({
  season,
  open,
  onOpenChange,
  onCreated,
}: {
  season: Season;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const [newName, setNewName] = useState(`${season.name} (copy)`);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const mutation = useMutation<{ season: Season }, Error, void>({
    mutationFn: async () => {
      const res = await fetch(`/api/seasons/${season.id}/duplicate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newName, startDate, endDate }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      onCreated();
      onOpenChange(false);
    },
  });

  const canSubmit = newName.trim() && startDate && endDate && !mutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Duplicate season</DialogTitle>
          <DialogDescription>
            Creates a new season with all products copied from "{season.name}".
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 mt-2">
          <Input
            label="New season name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-primary mb-1.5">Start date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="h-9 w-full rounded-md border border-default bg-base px-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/40"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-primary mb-1.5">End date</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="h-9 w-full rounded-md border border-default bg-base px-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/40"
              />
            </div>
          </div>
          {mutation.isError && (
            <div className="flex items-center gap-2 text-sm text-accent-danger">
              <AlertCircle className="size-4 shrink-0" />
              {mutation.error.message}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canSubmit}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            <Copy className="size-3.5" />
            Duplicate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Helpers -----------------------------------------------------------------

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr + "T00:00:00").toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}
