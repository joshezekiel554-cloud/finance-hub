// EditorField — TipTap-powered rich-text editor for the compose
// modal's body. Replaces the plain <textarea> so operators can
// bold/italic/list/link inline AND so paste from Outlook/Word/Gmail
// preserves formatting.
//
// What's enabled: starter-kit defaults (bold, italic, bullet list,
// numbered list, paragraphs, headings disabled) + the link extension.
// Operators get a small toolbar. Output is HTML; the parent component
// sends it to /api/send with `isHtml: true` and the server runs
// sanitize-html before stuffing it into the multipart payload.
//
// Paste handling: TipTap's StarterKit ships with paste rules that
// drop unknown marks/attributes from pasted HTML. Outlook's `mso-`-
// prefixed inline styles get stripped naturally because the schema
// doesn't recognise them. The result is "Outlook paste survives the
// content + basic formatting (bold/italic/lists), loses the noise."
//
// One note: TipTap controls its own editable element internally — we
// don't render the `editable` ref ourselves. That's why
// EditorContent + the editor handle come from useEditor.

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { useEffect, useState } from "react";
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Link as LinkIcon,
  Undo2,
  Redo2,
  Quote,
} from "lucide-react";
import { cn } from "../lib/cn";

export function EditorField({
  value,
  onChange,
  placeholder,
  // Reset signal — when this string changes, the editor's content is
  // forced back to `value`. Used for cases where the parent swaps the
  // body wholesale (e.g. dunning level switch refetching the rendered
  // template). Prevents the controlled-component drift problem
  // (TipTap holds its own state internally; setContent is the bridge).
  resetKey,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  resetKey?: string;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Disable headings — emails should not have <h1> in them.
        // Code blocks, blockquotes, lists, bold/italic stay on.
        heading: false,
      }),
      Link.configure({
        openOnClick: false,
        // Auto-detect URLs as the operator types — `https://...` becomes
        // a link without explicit toolbar invocation. Stops at whitespace.
        autolink: true,
        // External links open in new tab + add rel=noopener — outbound
        // emails don't need this for the recipient (their mail client
        // handles target/rel) but the editor preview behaves sanely.
        HTMLAttributes: {
          target: "_blank",
          rel: "noopener noreferrer",
        },
      }),
    ],
    content: value || "",
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
    editorProps: {
      attributes: {
        // Tailwind classes applied to the contenteditable root —
        // matches the look of the previous textarea so the modal feels
        // consistent. min-h matches the textarea's rows={16} feel.
        class: cn(
          "tiptap-content prose prose-sm max-w-none rounded-md border border-default bg-base px-3 py-2 text-sm text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/40 min-h-[18rem]",
        ),
        "data-placeholder": placeholder ?? "",
      },
    },
  });

  // When resetKey changes, force-load `value` into the editor. Skipped
  // when value is what the editor already has (avoids cursor jumps on
  // every keystroke in the parent).
  useEffect(() => {
    if (!editor) return;
    if (resetKey === undefined) return;
    if (editor.getHTML() === value) return;
    editor.commands.setContent(value || "", { emitUpdate: false });
  }, [resetKey, editor, value]);

  if (!editor) {
    return (
      <div className="rounded-md border border-default bg-base p-3 text-sm text-muted">
        Loading editor…
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}

// Compact toolbar — the buttons most operators reach for in a chase
// or reply email. Bold / italic / lists / link / blockquote / undo +
// redo. Each button reflects the editor's current state (active when
// the cursor is inside that mark).
function Toolbar({
  editor,
}: {
  editor: NonNullable<ReturnType<typeof useEditor>>;
}) {
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  function applyLink(): void {
    const trimmed = linkUrl.trim();
    if (!trimmed) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      const href = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    setLinkDialogOpen(false);
    setLinkUrl("");
  }

  return (
    <div className="flex flex-wrap items-center gap-0.5 rounded-md border border-default bg-subtle px-1 py-0.5">
      <ToolbarButton
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
        title="Bold (Ctrl+B)"
      >
        <Bold className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title="Italic (Ctrl+I)"
      >
        <Italic className="size-3.5" />
      </ToolbarButton>
      <ToolbarSeparator />
      <ToolbarButton
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        title="Bullet list"
      >
        <List className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        title="Numbered list"
      >
        <ListOrdered className="size-3.5" />
      </ToolbarButton>
      <ToolbarSeparator />
      <ToolbarButton
        active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        title="Quote (for replies)"
      >
        <Quote className="size-3.5" />
      </ToolbarButton>
      <div className="relative">
        <ToolbarButton
          active={editor.isActive("link")}
          onClick={() => {
            // Pre-fill the URL when editing an existing link.
            const existing = editor.getAttributes("link").href as
              | string
              | undefined;
            setLinkUrl(existing ?? "");
            setLinkDialogOpen((v) => !v);
          }}
          title="Insert/edit link"
        >
          <LinkIcon className="size-3.5" />
        </ToolbarButton>
        {linkDialogOpen ? (
          <div className="absolute left-0 top-full z-20 mt-1 flex items-center gap-1 rounded-md border border-default bg-base p-1.5 shadow-md">
            <input
              type="text"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyLink();
                } else if (e.key === "Escape") {
                  setLinkDialogOpen(false);
                  setLinkUrl("");
                }
              }}
              placeholder="https://example.com"
              autoFocus
              className="w-56 rounded border border-default bg-base px-2 py-0.5 text-xs"
            />
            <button
              type="button"
              onClick={applyLink}
              className="rounded bg-accent-primary px-2 py-0.5 text-xs font-medium text-white hover:opacity-90"
            >
              {linkUrl.trim() ? "Apply" : "Remove"}
            </button>
          </div>
        ) : null}
      </div>
      <ToolbarSeparator />
      <ToolbarButton
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
        title="Undo (Ctrl+Z)"
      >
        <Undo2 className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
        title="Redo (Ctrl+Shift+Z)"
      >
        <Redo2 className="size-3.5" />
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex h-6 items-center justify-center rounded px-1.5 text-secondary hover:bg-elevated hover:text-primary disabled:cursor-not-allowed disabled:opacity-40",
        active && "bg-elevated text-primary",
      )}
    >
      {children}
    </button>
  );
}

function ToolbarSeparator() {
  return <span className="mx-0.5 h-4 w-px bg-default" />;
}
