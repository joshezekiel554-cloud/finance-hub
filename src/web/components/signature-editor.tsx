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
  | { kind: "alias"; aliasEmail: string; html: string; isNew?: boolean };

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
  const [aliasEmail, setAliasEmail] = useState(
    initial.kind === "alias" ? initial.aliasEmail : "",
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
      const email = aliasEmail.trim().toLowerCase();
      if (!email) return;
      await onSave({ kind: "alias", aliasEmail: email, html });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {initial.kind === "user"
              ? "Edit signature"
              : initial.isNew
              ? "Add alias signature"
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

        {initial.kind === "alias" && initial.isNew && (
          <div className="grid gap-2">
            <label
              htmlFor="sig-alias"
              className="text-sm font-medium text-primary"
            >
              Alias email
            </label>
            <Input
              id="sig-alias"
              value={aliasEmail}
              onChange={(e) => setAliasEmail(e.target.value)}
              maxLength={254}
              placeholder="accounts@feldart.co.uk"
              type="email"
            />
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
              className="h-72 w-full rounded border border-default"
              style={{ background: "transparent" }}
              srcDoc={`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:transparent;color:#1f2937;font-family:Arial,Helvetica,sans-serif;font-size:14px;">${previewHtml}</body></html>`}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={
              overLimit ||
              saving ||
              (initial.kind === "alias" &&
                initial.isNew &&
                aliasEmail.trim().length === 0)
            }
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
