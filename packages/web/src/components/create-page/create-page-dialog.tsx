'use client';

import { m } from '@paraglide/messages.js';
import { FilePlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { usePagePathCandidates } from '@/lib/use-page-path-candidates';
import { cn } from '@/lib/utils';

/** Debounce before the prefix is sent to `/pages/autocomplete`. */
const QUERY_DEBOUNCE_MS = 150;

/** A keyboard-key chip, used to make Tab / Shift+Tab / Enter legible. */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none text-foreground shadow-sm">
      {children}
    </kbd>
  );
}

/**
 * Coerce a user-typed value into a `/`-rooted path. The leading slash is
 * fixed (re-added if the user deletes it); internal `//` runs are left
 * alone *while typing* so the candidate query stays a faithful prefix of
 * what's on screen — they're only collapsed at submit time
 * (`normaliseTarget`).
 */
function withLeadingSlash(raw: string): string {
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/**
 * The path actually created on submit: leading slash guaranteed, `//`
 * runs collapsed, trailing slash dropped (so `/foo/` resolves to `/foo`).
 */
function normaliseTarget(value: string): string {
  const collapsed = withLeadingSlash(value).replace(/\/+/g, '/');
  return collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
}

function CreatePageForm({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  // `typed` is the completion *stem* — the text the user actually typed.
  // It drives the candidate query and never changes on Tab. `preview` is
  // the currently cycled candidate shown in the input (null = show the
  // stem). The displayed value is `preview ?? typed`.
  const [typed, setTyped] = useState('/');
  const [preview, setPreview] = useState<string | null>(null);
  // Cycle position over [stem, ...candidates]: 0 = stem, k = candidate k-1.
  const [cyclePos, setCyclePos] = useState(0);

  const [debounced, setDebounced] = useState('/');
  useEffect(() => {
    const id = setTimeout(() => setDebounced(typed), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [typed]);

  // A bare `/` would match every page — only query once the user has
  // typed at least one character after the root slash.
  const { data } = usePagePathCandidates(debounced, { enabled: debounced.length > 1 });
  const prefixes = data?.prefixes ?? [];
  const existingPaths = data?.existingPaths ?? [];

  const displayed = preview ?? typed;
  const target = normaliseTarget(displayed);
  const endsWithSlash = displayed.length > 1 && displayed.endsWith('/');
  const isEmpty = target.length <= 1;
  // The level the user is currently at, derived from the stem (stable —
  // it doesn't shift while cycling a preview).
  const stemBase = normaliseTarget(typed);
  // Existing pages strictly *under* the current level. Excludes a page
  // sitting exactly at the level itself (that's the thing being extended,
  // not a child).
  const childPages = existingPaths.filter((p) => p !== stemBase);

  // Tab cycles the deeper namespaces when any exist; otherwise it cycles
  // the existing child pages, so the user can descend into a leaf
  // (`/path/to/foo` → `/path/to/foo/`) and create a page beneath it.
  const usingPrefixes = prefixes.length > 0;
  const candidates = usingPrefixes ? prefixes : childPages;

  // Only a real page sitting at exactly this path blocks creation. A
  // trailing slash means "namespace — keep typing", never a final path.
  const alreadyExists = existingPaths.includes(target);
  const canSubmit = !isEmpty && !endsWithSlash && !alreadyExists;

  const hasList = debounced.length > 1 && candidates.length > 0;

  const focusEnd = () => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  };

  const handleChange = (raw: string) => {
    setTyped(withLeadingSlash(raw));
    setPreview(null);
    setCyclePos(0);
  };

  const cycle = (direction: 1 | -1) => {
    if (candidates.length === 0) return;
    const slots = candidates.length + 1; // stem + candidates
    const next = (cyclePos + direction + slots) % slots;
    setCyclePos(next);
    setPreview(next === 0 ? null : candidates[next - 1]);
    // Defer caret move until the new value is painted.
    requestAnimationFrame(focusEnd);
  };

  // Commit a candidate into the stem. `descend` (Shift) turns a leaf page
  // into a namespace (`/foo` → `/foo/`) so the next keystrokes create a
  // child; prefixes already end in `/` so it's a no-op for them.
  const selectCandidate = (path: string, descend: boolean) => {
    setTyped(descend && !path.endsWith('/') ? `${path}/` : path);
    setPreview(null);
    setCyclePos(0);
    focusEnd();
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    router.push(`/_edit?path=${encodeURIComponent(target)}`);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab') {
      // Tab is hijacked for completion; Esc / the cancel button are the
      // documented ways out of the field (focus trap handled by Dialog).
      e.preventDefault();
      cycle(e.shiftKey ? -1 : 1);
    }
  };

  // Highlighted candidate row (the one currently previewed), or none.
  const activeIndex = cyclePos === 0 ? -1 : cyclePos - 1;

  // Create affordance with the target path emphasised inside the localised
  // sentence ("{path} を作成" / "Create {path}").
  const createHint = m['create_page.create_hint']({ path: target });
  const [hintBefore, hintAfter = ''] = createHint.split(target);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit();
      }}
      className="flex flex-col gap-3"
    >
      <Input
        ref={inputRef}
        value={displayed}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        // The path field is the sole purpose of this modal, so focusing it
        // on open is the expected UX (and the focus is inside a dialog).
        autoFocus
        spellCheck={false}
        autoComplete="off"
        aria-label={m['create_page.input_aria']()}
        aria-describedby={listId}
        className="h-12 font-mono text-lg"
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Kbd>Tab</Kbd>
          {m['create_page.kbd_next']()}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>⇧</Kbd>
          <Kbd>Tab</Kbd>
          {m['create_page.kbd_prev']()}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Enter</Kbd>
          {m['create_page.kbd_submit']()}
        </span>
      </div>

      <div id={listId} className="min-h-[2.5rem]">
        {hasList ? (
          <>
            {!usingPrefixes ? <p className="px-1 pb-1 text-xs text-muted-foreground">{m['create_page.existing_pages_hint']()}</p> : null}
            <ul className="flex flex-col overflow-hidden rounded-md border">
              {candidates.map((path, i) => (
                <li key={path}>
                  <button
                    type="button"
                    onClick={(e) => selectCandidate(path, e.shiftKey)}
                    className={cn(
                      'flex w-full items-center px-3 py-1.5 text-left font-mono text-sm transition-colors hover:bg-accent',
                      i === activeIndex && 'bg-accent',
                    )}
                  >
                    {path}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>

      {/* Status line: one of namespace-prompt / exists-error / create-hint. */}
      {endsWithSlash ? (
        <p className="text-sm text-muted-foreground">{m['create_page.continue_typing']()}</p>
      ) : alreadyExists ? (
        <p className="text-sm text-destructive">{m['create_page.exists_error']()}</p>
      ) : canSubmit ? (
        <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
          <Kbd>Enter</Kbd>
          <span>
            {hintBefore}
            <code className="font-mono font-medium text-foreground">{target}</code>
            {hintAfter}
          </span>
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          {m['common.cancel']()}
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {m['create_page.submit']()}
        </Button>
      </div>
    </form>
  );
}

/**
 * Header entry point for the new-page flow: a "Create page" button that
 * opens a modal where the user builds a `/`-rooted path with Tab-cycle
 * completion against existing pages. Submitting routes to the create-mode
 * editor (`/_edit?path=…`).
 */
export function CreatePageButton() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground">
          <FilePlus className="h-4 w-4" />
          <span className="hidden sm:inline">{m['header.create_page']()}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{m['create_page.title']()}</DialogTitle>
          <DialogDescription>{m['create_page.description']()}</DialogDescription>
        </DialogHeader>
        {/* Remount the form per open so its state resets cleanly. */}
        {open ? <CreatePageForm onClose={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}
