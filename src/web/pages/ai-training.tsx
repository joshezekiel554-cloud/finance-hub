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
    </div>
  );
}
