import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Button } from "../components/ui/button";

type AppSettingsResponse = { settings: Record<string, string> };

export default function AiTrainingPage() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const settingsQuery = useQuery<AppSettingsResponse>({
    queryKey: ["app-settings"],
    queryFn: async () => {
      const res = await fetch("/api/app-settings");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  useEffect(() => {
    if (settingsQuery.data) {
      setDraft(settingsQuery.data.settings["ai_voice_guide"] ?? "");
    }
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/app-settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ai_voice_guide: draft }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as AppSettingsResponse;
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["app-settings"] });
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
  });

  const regenMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/ai-training/voice-guide/regenerate", {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as { ok: boolean; words: number };
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["app-settings"] });
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">AI Training</h1>
        <p className="mt-1 text-sm text-secondary">
          Teach autopilot how Feldart writes. The voice guide is injected into
          every AI draft.
        </p>
      </div>

      <Card>
        <CardHeader>Voice guide</CardHeader>
        <CardBody>
          <textarea
            className="w-full min-h-[320px] rounded border border-default bg-transparent p-3 font-mono text-sm"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Loading…"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-secondary">
              {draft.length} characters
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                loading={regenMutation.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      "Regenerate overwrites the current guide (including manual edits) from your templates + recent emails. Continue?",
                    )
                  ) {
                    regenMutation.mutate();
                  }
                }}
              >
                Regenerate from my emails
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={saveMutation.isPending}
                onClick={() => saveMutation.mutate()}
              >
                Save
              </Button>
            </div>
          </div>
          {error ? (
            <p className="mt-2 text-sm text-accent-danger">{error}</p>
          ) : null}
          <p className="mt-3 text-xs text-secondary">
            Worked-example templates are wired for chase emails (L1/L2/L3 by
            severity). Cold check-ins and statements use the voice guide alone
            until a matching template exists.
          </p>
        </CardBody>
      </Card>

      <CompanyFactsCard />
    </div>
  );
}

type Fact = {
  id: string;
  fact: string;
  tags: string[];
  active: boolean;
};

function CompanyFactsCard() {
  const queryClient = useQueryClient();
  const [newFact, setNewFact] = useState("");
  const [newTags, setNewTags] = useState("global");
  const [error, setError] = useState<string | null>(null);

  const factsQuery = useQuery<{ facts: Fact[] }>({
    queryKey: ["ai-company-facts"],
    queryFn: async () => {
      const res = await fetch("/api/ai-training/facts");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["ai-company-facts"] });
  const onErr = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));

  const createMutation = useMutation({
    mutationFn: async () => {
      const tags = newTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const res = await fetch("/api/ai-training/facts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fact: newFact, tags }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `HTTP ${res.status}`);
      }
    },
    onSuccess: () => {
      setNewFact("");
      setNewTags("global");
      setError(null);
      invalidate();
    },
    onError: onErr,
  });

  const retireMutation = useMutation({
    mutationFn: async (f: Fact) => {
      const res = await fetch(`/api/ai-training/facts/${f.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: !f.active }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: onErr,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/ai-training/facts/${id}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: onErr,
  });

  return (
    <Card>
      <CardHeader>Company facts</CardHeader>
      <CardBody>
        <p className="mb-3 text-xs text-secondary">
          Durable facts the AI should know. Tag <code>global</code> to apply to
          every draft, or a category (<code>chase_next</code>,{" "}
          <code>cadence_cold</code>, <code>ops_rma_stalled</code>) to scope it.
        </p>

        <div className="space-y-2">
          {(factsQuery.data?.facts ?? []).map((f) => (
            <div
              key={f.id}
              className={`flex items-start justify-between gap-3 rounded border border-default p-2 ${f.active ? "" : "opacity-50"}`}
            >
              <div className="min-w-0">
                <div className="text-sm">{f.fact}</div>
                <div className="mt-1 text-xs text-secondary">
                  {f.tags.join(", ") || "—"} {f.active ? "" : "(retired)"}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => retireMutation.mutate(f)}
                >
                  {f.active ? "Retire" : "Restore"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (window.confirm("Delete this fact permanently?"))
                      deleteMutation.mutate(f.id);
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 space-y-2 border-t border-default pt-3">
          <textarea
            className="w-full rounded border border-default bg-transparent p-2 text-sm"
            rows={2}
            placeholder="New fact (e.g. We close for two weeks in August)"
            value={newFact}
            onChange={(e) => setNewFact(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <input
              className="flex-1 rounded border border-default bg-transparent p-2 text-sm"
              placeholder="tags, comma-separated (global, chase_next)"
              value={newTags}
              onChange={(e) => setNewTags(e.target.value)}
            />
            <Button
              variant="primary"
              size="sm"
              loading={createMutation.isPending}
              onClick={() => {
                if (newFact.trim()) createMutation.mutate();
              }}
            >
              Add fact
            </Button>
          </div>
        </div>
        {error ? (
          <p className="mt-2 text-sm text-accent-danger">{error}</p>
        ) : null}
      </CardBody>
    </Card>
  );
}
