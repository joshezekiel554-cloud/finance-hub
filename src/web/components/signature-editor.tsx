// src/web/components/signature-editor.tsx
import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export type SignatureEditorMode =
  | { kind: "user"; id?: string; name: string; html: string; isDefault: boolean }
  | { kind: "alias"; aliasEmail: string; html: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: SignatureEditorMode;
  onSave: (payload: SignatureEditorMode) => Promise<void>;
  saving?: boolean;
};

const MAX_BYTES = 32 * 1024;

export function SignatureEditor({
  open,
  onOpenChange,
  initial,
  onSave,
  saving,
}: Props) {
  const [name, setName] = useState(
    initial.kind === "user" ? initial.name : initial.aliasEmail,
  );
  const [html, setHtml] = useState(initial.html);
  const [isDefault, setIsDefault] = useState(
    initial.kind === "user" ? initial.isDefault : false,
  );
  const [previewHtml, setPreviewHtml] = useState(html);

  // Debounced preview update
  useEffect(() => {
    const t = setTimeout(() => setPreviewHtml(html), 200);
    return () => clearTimeout(t);
  }, [html]);

  const bytes = useMemo(() => new Blob([html]).size, [html]);
  const overLimit = bytes > MAX_BYTES;

  const handleSave = async () => {
    if (overLimit) return;
    if (initial.kind === "user") {
      await onSave({ kind: "user", id: initial.id, name, html, isDefault });
    } else {
      await onSave({ kind: "alias", aliasEmail: initial.aliasEmail, html });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {initial.kind === "user"
              ? "Edit signature"
              : `Edit ${initial.aliasEmail} signature`}
          </DialogTitle>
          <DialogDescription>
            Paste pre-built HTML. The preview shows exactly what will be saved
            after sanitisation.
          </DialogDescription>
        </DialogHeader>

        {initial.kind === "user" && (
          <div className="grid gap-2">
            <label
              htmlFor="sig-name"
              className="text-sm font-medium text-primary"
            >
              Name
            </label>
            <Input
              id="sig-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              placeholder="Casual sign-off"
            />
            <label className="flex items-center gap-2 text-sm text-primary">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
              />
              Set as default
            </label>
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-1">
            <label
              htmlFor="sig-html"
              className="text-sm font-medium text-primary"
            >
              HTML source
            </label>
            <textarea
              id="sig-html"
              className="font-mono text-xs h-72 rounded border border-default bg-base p-2 text-primary"
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              spellCheck={false}
            />
            <div
              className={
                overLimit ? "text-xs text-accent-danger" : "text-xs text-muted"
              }
            >
              {bytes.toLocaleString()} / {MAX_BYTES.toLocaleString()} bytes
              {overLimit && " — too large; trim before saving"}
            </div>
          </div>
          <div className="grid gap-1">
            <span className="text-sm font-medium text-primary">Preview</span>
            <iframe
              title="signature preview"
              // empty sandbox — no parent-origin access
              sandbox=""
              className="h-72 w-full rounded border border-default bg-white"
              srcDoc={previewHtml}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={overLimit || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
