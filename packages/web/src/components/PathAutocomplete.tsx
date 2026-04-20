import type * as React from "react";
/**
 * PathAutocomplete — a text field that suggests subdirectories as the
 * user types an absolute path.
 *
 * UX shape:
 *   - The user types (or pastes) an absolute path into the field.
 *   - Below the field we show the directories inside "the current
 *     context path" — i.e. `dirname(input)` if the input doesn't end
 *     in `/`, otherwise `input` itself.
 *   - Entries matching the basename prefix float to the top; everything
 *     else is listed too so the user can see siblings.
 *   - Keyboard: ↑/↓ move the highlight, Enter/Tab commit the highlight
 *     as the new field value (appending "/"), Esc clears the dropdown.
 *   - Mouse: click an entry, same effect.
 *
 * Why not a Finder-style popover: typing-first matches the habits of
 * developers who already know roughly where the project lives. The
 * dropdown reveals siblings and completes the tail — it doesn't force
 * a full tree browse.
 *
 * Why only dirs on the suggestion list (not files): the consumer of
 * this component is the Register Project dialog, which only cares
 * about directories. Files are shown disabled so the user knows the
 * field *is* seeing the filesystem correctly.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";

import { api, AstackError } from "../lib/api.js";
import type { FsEntry } from "@astack/shared";

interface PathAutocompleteProps {
  value: string;
  onChange: (next: string) => void;
  /** Fired when the user presses Enter on the field itself (not on a
   *  dropdown item) — typically the caller treats this as "submit". */
  onSubmit?: () => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  id?: string;
}

/**
 * Split an input path into (context dir, basename prefix).
 *
 *   "/Users/alex/co"     → { dir: "/Users/alex",     prefix: "co" }
 *   "/Users/alex/code/"  → { dir: "/Users/alex/code", prefix: "" }
 *   "/"                   → { dir: "/",                prefix: "" }
 *   ""                    → { dir: "",                 prefix: "" }  // server falls back to $HOME
 */
function splitPath(input: string): { dir: string; prefix: string } {
  if (input === "") return { dir: "", prefix: "" };
  if (input.endsWith("/")) return { dir: input, prefix: "" };
  const idx = input.lastIndexOf("/");
  if (idx === -1) return { dir: input, prefix: "" };
  if (idx === 0) return { dir: "/", prefix: input.slice(1) };
  return { dir: input.slice(0, idx), prefix: input.slice(idx + 1) };
}

export function PathAutocomplete({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  autoFocus,
  id
}: PathAutocompleteProps): React.JSX.Element {
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [loading, setLoading] = useState(false);
  const [serverPath, setServerPath] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // "Which dir am I listing?" — recomputed whenever the field changes.
  const { dir, prefix } = useMemo(() => splitPath(value), [value]);

  // Fetch the directory listing when `dir` changes. We debounce by
  // letting React coalesce setState; real-world typing produces very
  // few fetches because `dir` only changes when the user crosses a `/`.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .fsList({ path: dir || undefined })
      .then((res) => {
        if (cancelled) return;
        setEntries(res.entries);
        setServerPath(res.exists ? res.path : null);
      })
      .catch((err) => {
        if (cancelled) return;
        setEntries([]);
        setServerPath(null);
        if (!(err instanceof AstackError)) {
          // eslint-disable-next-line no-console
          console.warn("fsList failed", err);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dir]);

  // Rank: prefix matches first (case-insensitive), then the rest, then
  // files at the bottom (shown but not selectable).
  const ranked = useMemo(() => {
    const p = prefix.toLowerCase();
    const dirs = entries.filter((e) => e.kind === "dir");
    const matched = p
      ? dirs.filter((e) => e.name.toLowerCase().startsWith(p))
      : dirs;
    const unmatched = p
      ? dirs.filter((e) => !e.name.toLowerCase().startsWith(p))
      : [];
    const files = entries.filter((e) => e.kind === "file");
    return { matched, unmatched, files };
  }, [entries, prefix]);

  const selectable = useMemo(
    () => [...ranked.matched, ...ranked.unmatched],
    [ranked]
  );

  // Keep highlight in range when the ranked list changes (e.g. typing
  // narrows the matches). Always snap back to the first match.
  useEffect(() => {
    setHighlight(0);
  }, [dir, prefix]);

  // Close the dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const commit = useCallback(
    (entry: FsEntry) => {
      // Trailing slash so the UI immediately fetches this dir's children
      // and the user can keep drilling in without pressing Tab again.
      onChange(entry.path + "/");
      setOpen(true);
      inputRef.current?.focus();
    },
    [onChange]
  );

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, Math.max(selectable.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Tab" && open && selectable.length > 0) {
      // Tab = complete (don't lose focus).
      e.preventDefault();
      commit(selectable[highlight]!);
    } else if (e.key === "Enter") {
      if (open && selectable.length > 0 && highlight < selectable.length) {
        // Enter on a highlighted dropdown item = drill in, don't submit.
        e.preventDefault();
        commit(selectable[highlight]!);
      } else if (onSubmit) {
        // Enter on the raw field (no dropdown) = submit the form.
        e.preventDefault();
        onSubmit();
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  // Ensure the highlighted entry stays in view when the user arrows past
  // the visible portion of the dropdown.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLLIElement>(
      `[data-idx="${highlight}"]`
    );
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const showDropdown = open && (entries.length > 0 || loading);
  const pathInvalid = value.trim() !== "" && serverPath === null && !loading;

  return (
    <div ref={wrapRef} className="relative">
      <input
        id={id}
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder ?? "/Users/you/code/my-project"}
        disabled={disabled}
        autoFocus={autoFocus}
        spellCheck={false}
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={showDropdown}
        aria-controls={id ? `${id}-listbox` : undefined}
        className={
          "w-full h-9 px-3 bg-surface-1 border rounded-md " +
          "text-sm font-mono text-fg-primary placeholder-fg-tertiary " +
          "focus:outline-none focus:bg-surface-2 transition-colors " +
          (pathInvalid
            ? "border-warn/50 focus:border-warn/70"
            : "border-line-subtle focus:border-accent/60")
        }
      />

      {showDropdown ? (
        <ul
          ref={listRef}
          id={id ? `${id}-listbox` : undefined}
          role="listbox"
          className="absolute z-20 left-0 right-0 top-[calc(100%+4px)]
            max-h-64 overflow-auto py-1
            bg-surface-3 border border-line rounded-md shadow-xl shadow-black/30
            backdrop-blur"
        >
          {loading && entries.length === 0 ? (
            <li className="px-3 py-1.5 text-xs text-fg-tertiary">Loading…</li>
          ) : null}

          {ranked.matched.length === 0 &&
          ranked.unmatched.length === 0 &&
          !loading ? (
            <li className="px-3 py-1.5 text-xs text-fg-tertiary">
              No subdirectories.
            </li>
          ) : null}

          {selectable.map((entry, idx) => (
            <li
              key={entry.path}
              data-idx={idx}
              role="option"
              aria-selected={idx === highlight}
              onMouseDown={(e) => {
                // Prevent input blur before click fires.
                e.preventDefault();
                setHighlight(idx);
                commit(entry);
              }}
              onMouseEnter={() => setHighlight(idx)}
              className={
                "flex items-center gap-2 px-3 h-7 text-sm cursor-pointer " +
                (idx === highlight
                  ? "bg-accent/15 text-fg-primary"
                  : "text-fg-secondary")
              }
            >
              <FolderIcon />
              <span className="font-mono truncate">{entry.name}</span>
            </li>
          ))}

          {ranked.files.length > 0 ? (
            <li
              role="separator"
              className="mt-1 border-t border-line-subtle pt-1 px-3 text-[11px] uppercase tracking-wider text-fg-quaternary"
            >
              files (not selectable)
            </li>
          ) : null}
          {ranked.files.slice(0, 5).map((entry) => (
            <li
              key={entry.path}
              role="option"
              aria-disabled="true"
              className="flex items-center gap-2 px-3 h-7 text-sm text-fg-quaternary"
            >
              <FileIcon />
              <span className="font-mono truncate">{entry.name}</span>
            </li>
          ))}
          {ranked.files.length > 5 ? (
            <li className="px-3 h-6 text-[11px] text-fg-quaternary">
              +{ranked.files.length - 5} more files
            </li>
          ) : null}
        </ul>
      ) : null}

      {pathInvalid ? (
        <div className="mt-1 text-xs text-warn">
          Path doesn't exist (yet). You can still register if you'll create it
          first.
        </div>
      ) : null}
    </div>
  );
}

function FolderIcon(): React.JSX.Element {
  return (
    <svg
      aria-hidden
      width="12"
      height="12"
      viewBox="0 0 14 14"
      className="shrink-0 text-fg-tertiary"
    >
      <path
        d="M1.5 3.5a1 1 0 0 1 1-1h3l1.2 1.5h4.8a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-7z"
        fill="currentColor"
        opacity="0.75"
      />
    </svg>
  );
}

function FileIcon(): React.JSX.Element {
  return (
    <svg
      aria-hidden
      width="12"
      height="12"
      viewBox="0 0 14 14"
      className="shrink-0 text-fg-quaternary"
    >
      <path
        d="M3 2h5.5L11.5 5v7a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm5 0.5V5h2.5"
        stroke="currentColor"
        strokeWidth="1"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
