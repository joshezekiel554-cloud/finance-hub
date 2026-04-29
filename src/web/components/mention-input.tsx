import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "../lib/cn";

type User = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
};

export type MentionInputHandle = {
  focus: () => void;
  clear: () => void;
};

type Props = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "onChange" | "value"
> & {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: () => void;
};

// Match the trailing @-token at the cursor. Stops on whitespace, so
// "hi @jo|" matches "jo" but "hi @jo |" does not.
const TOKEN_RE = /(^|\s)@([\w.-]*)$/;

export const MentionInput = forwardRef<MentionInputHandle, Props>(
  ({ value, onChange, onSubmit, className, onKeyDown, ...rest }, ref) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [token, setToken] = useState<string | null>(null);
    const [tokenStart, setTokenStart] = useState<number>(-1);
    const [results, setResults] = useState<User[]>([]);
    const [highlight, setHighlight] = useState(0);
    const [open, setOpen] = useState(false);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => textareaRef.current?.focus(),
        clear: () => onChange(""),
      }),
      [onChange],
    );

    // Detect an @-token at the current cursor on every value change.
    const detectToken = useCallback((next: string, caret: number) => {
      const slice = next.slice(0, caret);
      const match = slice.match(TOKEN_RE);
      if (!match) {
        setToken(null);
        setTokenStart(-1);
        setOpen(false);
        return;
      }
      const t = match[2] ?? "";
      const start = caret - t.length - 1;
      setToken(t);
      setTokenStart(start);
      setOpen(true);
      setHighlight(0);
    }, []);

    function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
      const next = e.target.value;
      onChange(next);
      const caret = e.target.selectionStart ?? next.length;
      detectToken(next, caret);
    }

    // Debounced fetch of /api/users?q=. Skip the network when the popover
    // isn't open. Empty token still fires (q="") so the user gets a list
    // of suggestions immediately after typing "@".
    useEffect(() => {
      if (!open || token === null) return;
      const handle = setTimeout(async () => {
        try {
          const res = await fetch(
            `/api/users?q=${encodeURIComponent(token)}`,
          );
          if (!res.ok) {
            setResults([]);
            return;
          }
          const body = (await res.json()) as { users: User[] };
          setResults(body.users.slice(0, 8));
          setHighlight(0);
        } catch {
          setResults([]);
        }
      }, 120);
      return () => clearTimeout(handle);
    }, [open, token]);

    function selectUser(user: User) {
      if (tokenStart < 0) return;
      const handle = (user.name ?? user.email).split(/\s+/)[0] ?? user.email;
      const before = value.slice(0, tokenStart);
      const after = value.slice(
        tokenStart + 1 + (token?.length ?? 0),
      );
      const inserted = `@${handle} `;
      const next = before + inserted + after;
      onChange(next);
      setOpen(false);
      setToken(null);
      setTokenStart(-1);
      // Restore caret position after the inserted handle.
      requestAnimationFrame(() => {
        const pos = before.length + inserted.length;
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(pos, pos);
        }
      });
    }

    function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
      if (open && results.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHighlight((h) => (h + 1) % results.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHighlight((h) => (h - 1 + results.length) % results.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const u = results[highlight];
          if (u) selectUser(u);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setOpen(false);
          return;
        }
      }
      // Cmd/Ctrl-Enter submits the form
      if (
        onSubmit &&
        e.key === "Enter" &&
        (e.metaKey || e.ctrlKey) &&
        !open
      ) {
        e.preventDefault();
        onSubmit();
        return;
      }
      onKeyDown?.(e);
    }

    return (
      <div className="relative">
        <textarea
          {...rest}
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            // Delay so a click on the popover registers before we close.
            setTimeout(() => setOpen(false), 150);
          }}
          className={cn(
            "w-full resize-y rounded-md border border-default bg-base px-3 py-2 text-sm",
            "placeholder:text-muted",
            "focus:outline-none focus:ring-2 focus:ring-accent-primary/40",
            className,
          )}
        />
        {open && results.length > 0 && (
          <div
            role="listbox"
            className="absolute left-0 top-full z-20 mt-1 max-h-72 w-72 overflow-y-auto rounded-md border border-default bg-base shadow-lg"
          >
            {results.map((u, i) => (
              <button
                key={u.id}
                type="button"
                role="option"
                aria-selected={i === highlight}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectUser(u);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full items-center gap-2 border-b border-default px-3 py-2 text-left text-sm last:border-b-0",
                  i === highlight ? "bg-elevated" : "hover:bg-elevated",
                )}
              >
                <Avatar user={u} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {u.name ?? u.email.split("@")[0]}
                  </div>
                  <div className="truncate text-xs text-muted">{u.email}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  },
);
MentionInput.displayName = "MentionInput";

function Avatar({ user }: { user: User }) {
  if (user.image) {
    return (
      <img
        src={user.image}
        alt=""
        className="size-7 shrink-0 rounded-full"
      />
    );
  }
  const initial = (user.name ?? user.email).charAt(0).toUpperCase();
  return (
    <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-primary/15 text-xs font-medium text-accent-primary">
      {initial}
    </div>
  );
}

// Renders a comment body with @mentions highlighted. Used by the comments
// thread + the task drawer's body preview. Detection is the same regex as
// the server uses to write `mentions` rows.
export function MentionText({ body }: { body: string }) {
  const parts = useMemo(() => {
    const out: Array<{ type: "text" | "mention"; value: string }> = [];
    const re = /@([\w.-]+)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      if (m.index > last) {
        out.push({ type: "text", value: body.slice(last, m.index) });
      }
      out.push({ type: "mention", value: m[0] });
      last = m.index + m[0].length;
    }
    if (last < body.length) {
      out.push({ type: "text", value: body.slice(last) });
    }
    return out;
  }, [body]);
  return (
    <>
      {parts.map((p, i) =>
        p.type === "mention" ? (
          <span
            key={i}
            className="font-semibold text-accent-primary"
          >
            {p.value}
          </span>
        ) : (
          <span key={i}>{p.value}</span>
        ),
      )}
    </>
  );
}
