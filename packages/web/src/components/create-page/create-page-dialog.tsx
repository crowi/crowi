'use client';

import { m } from '@paraglide/messages.js';
import { FilePlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/lib/use-auth';
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

/** Today's date as a `/`-separated Crowi date hierarchy (`2026/06/03`). */
function todayHierarchy(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}/${mo}/${d}`;
}

interface CreatePageFormProps {
  /**
   * The `/`-rooted namespace to pre-fill (e.g. `/` from the header, or the
   * current list path `/crowi/qa/` from the list-header button). Normalised
   * to a trailing slash so the "dated note here" shortcut concatenates
   * cleanly.
   */
  defaultDir: string;
  onClose: () => void;
}

function CreatePageForm({ defaultDir, onClose }: CreatePageFormProps) {
  const router = useRouter();
  const { user } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  // Captured once at open: the namespace to pre-fill (trailing-slash
  // normalised) and today's date for the quick "dated page" shortcuts.
  const [currentDir] = useState(() => (defaultDir.endsWith('/') ? defaultDir : `${defaultDir}/`));
  const [today] = useState(() => todayHierarchy(new Date()));

  // `typed` is the completion *stem* — the text the user actually typed.
  // It drives the candidate query and never changes on Tab. `preview` is
  // the currently cycled candidate shown in the input (null = show the
  // stem). The displayed value is `preview ?? typed`.
  const [typed, setTyped] = useState(currentDir);
  const [preview, setPreview] = useState<string | null>(null);
  // Cycle position over [stem, ...candidates]: 0 = stem, k = candidate k-1.
  const [cyclePos, setCyclePos] = useState(0);
  // Quick shortcuts (root / dated memo / dated note here) are offered only
  // until the user starts editing — once they do, the list is pure path
  // completion.
  const [touched, setTouched] = useState(false);

  const [debounced, setDebounced] = useState(currentDir);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(typed), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [typed]);

  // Always query — even at the bare root `/`, where we want the first-level
  // namespaces (`/crowi/`, `/path/`, …) listed below the shortcuts. The
  // endpoint caps the scan at 25 rows, so a root match-all stays bounded.
  const { data } = usePagePathCandidates(debounced);
  const prefixes = data?.prefixes ?? [];
  const existingPaths = data?.existingPaths ?? [];

  const displayed = preview ?? typed;
  const target = normaliseTarget(displayed);
  // A trailing slash — including the bare root `/` — is a namespace, not a
  // final path: not creatable here (portals aren't made from this modal),
  // so it shows the "keep typing" prompt rather than an exists-error.
  const endsWithSlash = displayed.endsWith('/');
  const isEmpty = target.length <= 1;
  const stemBase = normaliseTarget(typed);
  const childPages = existingPaths.filter((p) => p !== stemBase);

  // Deeper namespaces first; otherwise existing child pages (descend into a
  // leaf to create a page beneath it).
  const usingPrefixes = prefixes.length > 0;
  const normalCandidates = usingPrefixes ? prefixes : childPages;

  // Quick shortcuts so a special path / today's date is always one Tab
  // away from a freshly-opened modal: root, a personal dated memo, and a
  // dated note in the current namespace. They vanish as soon as the user
  // edits the field. At the root itself the `/` jump and the "dated note
  // here" (`/2026/06/03`) shortcuts are pointless, so only the personal
  // memo remains — with the first-level namespaces listed beneath it.
  const atRoot = currentDir === '/';
  const memoPath = user?.username ? `/user/${user.username}/memo/${today}` : null;
  const datedHerePath = `${currentDir}${today}`;
  const specials = touched ? [] : [atRoot ? null : '/', memoPath, atRoot ? null : datedHerePath].filter((p): p is string => p !== null);

  // The single dedupe here also collapses any overlap *within* specials
  // (e.g. the dated-note-here shortcut coinciding with the personal memo
  // when listing your own `/user/<me>/memo/` namespace).
  const candidates = [...new Set([...specials, ...normalCandidates])];
  const hasList = candidates.length > 0;

  // Only a real page sitting at exactly this path blocks creation. A
  // trailing slash means "namespace — keep typing", never a final path.
  const alreadyExists = existingPaths.includes(target);
  const canSubmit = !isEmpty && !endsWithSlash && !alreadyExists;

  const specialLabel = (path: string): string | null => {
    if (path === '/') return m['create_page.special_root']();
    if (path === memoPath) return m['create_page.special_memo']();
    if (path === datedHerePath) return m['create_page.special_today']();
    return null;
  };

  const focusEnd = () => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  };

  // Reset the Tab-cycle whenever the stem changes (typing or picking a
  // candidate): clear the preview, return to the stem slot, and mark the
  // field edited so the quick-shortcuts drop out.
  const resetCompletion = () => {
    setPreview(null);
    setCyclePos(0);
    setTouched(true);
  };

  const handleChange = (raw: string) => {
    setTyped(withLeadingSlash(raw));
    resetCompletion();
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

  // Commit a candidate into the stem. `descend` (Shift) turns a leaf into a
  // namespace (`/foo` → `/foo/`) so the next keystrokes create a child;
  // prefixes already end in `/` so it's a no-op for them.
  const selectCandidate = (path: string, descend: boolean) => {
    setTyped(descend && !path.endsWith('/') ? `${path}/` : path);
    resetCompletion();
    focusEnd();
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    router.push(`/_edit?path=${encodeURIComponent(target)}`);
    onClose();
  };

  // Navigate to the page that already lives at `target` (wiki pages are
  // served at their own path). Offered when creation is blocked because the
  // path exists.
  const goToExisting = () => {
    router.push(target);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab') {
      // Tab is hijacked for completion; Esc / the cancel button are the
      // documented ways out of the field (focus trap handled by Dialog).
      e.preventDefault();
      cycle(e.shiftKey ? -1 : 1);
      return;
    }
    // Shift+Enter on an existing path jumps to that page instead of trying
    // (and failing) to create it.
    if (e.key === 'Enter' && e.shiftKey && alreadyExists) {
      e.preventDefault();
      goToExisting();
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
      className="flex min-h-0 flex-1 flex-col gap-3"
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
        className="h-12 shrink-0 font-mono text-lg"
      />

      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Kbd>Tab</Kbd>
          {m['create_page.kbd_next']()}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Shift</Kbd>
          <Kbd>Tab</Kbd>
          {m['create_page.kbd_prev']()}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Enter</Kbd>
          {m['create_page.kbd_submit']()}
        </span>
      </div>

      <div id={listId} className="min-h-0 flex-1 overflow-y-auto">
        {hasList ? (
          <>
            {touched && !usingPrefixes && childPages.length > 0 ? (
              <p className="px-1 pb-1 text-xs text-muted-foreground">{m['create_page.existing_pages_hint']()}</p>
            ) : null}
            <ul className="flex flex-col overflow-hidden rounded-md border">
              {candidates.map((path, i) => {
                const label = specialLabel(path);
                return (
                  <li key={path}>
                    <button
                      type="button"
                      onClick={(e) => selectCandidate(path, e.shiftKey)}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-sm transition-colors hover:bg-accent',
                        i === activeIndex && 'bg-accent',
                      )}
                    >
                      <span className="min-w-0 truncate">{path}</span>
                      {label ? <span className="ml-auto shrink-0 text-xs text-muted-foreground">{label}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </div>

      {/* Status line: one of namespace-prompt / exists-error / create-hint. */}
      {endsWithSlash ? (
        <p className="shrink-0 text-sm text-muted-foreground">{m['create_page.continue_typing']()}</p>
      ) : alreadyExists ? (
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="text-destructive">{m['create_page.exists_error']()}</span>
          <button
            type="button"
            onClick={goToExisting}
            className="inline-flex items-center gap-1.5 font-medium text-foreground underline underline-offset-2 hover:opacity-80"
          >
            {m['create_page.go_to_page']()}
            <span className="flex items-center gap-0.5">
              <Kbd>Shift</Kbd>
              <Kbd>Enter</Kbd>
            </span>
          </button>
        </div>
      ) : canSubmit ? (
        <p className="flex shrink-0 flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
          <Kbd>Enter</Kbd>
          <span>
            {hintBefore}
            <code className="font-mono font-medium text-foreground">{target}</code>
            {hintAfter}
          </span>
        </p>
      ) : null}

      <div className="flex shrink-0 justify-end gap-2">
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

interface CreatePageDialogProps {
  /** The namespace the modal pre-fills (`/` for the header entry point). */
  defaultDir: string;
  /** The button that opens the modal (rendered as the dialog trigger). */
  trigger: React.ReactNode;
}

/**
 * The new-page modal: build a `/`-rooted path with shell-like Tab-cycle
 * completion against existing pages, then route to the create-mode editor
 * (`/_edit?path=…`). Reused from two entry points with different
 * pre-filled namespaces via `defaultDir`.
 */
function CreatePageDialog({ defaultDir, trigger }: CreatePageDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      {/* Top-anchored (not vertically centred) so the input stays put at
          ~40% of the viewport as the candidate list grows, instead of the
          whole dialog drifting upward. `max-h` lets it extend down to a
          ~2rem gap above the viewport bottom; the candidate list scrolls
          internally past that. */}
      <DialogContent className="top-[34dvh] flex max-h-[calc(100dvh-34dvh-2rem)] translate-y-0 flex-col overflow-hidden sm:max-w-xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>{m['create_page.title']()}</DialogTitle>
          <DialogDescription>{m['create_page.description']()}</DialogDescription>
        </DialogHeader>
        {/* Remount the form per open so its state resets cleanly. */}
        {open ? <CreatePageForm defaultDir={defaultDir} onClose={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Header entry point. Always starts from the root (`/`) — it is a global
 * "new page" action with no location context.
 */
export function CreatePageButton() {
  return (
    <CreatePageDialog
      defaultDir="/"
      trigger={
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground">
          <FilePlus className="h-4 w-4" />
          <span className="hidden sm:inline">{m['header.create_page']()}</span>
        </Button>
      }
    />
  );
}

/**
 * List-header entry point (sits next to the "N pages" count). Pre-fills the
 * namespace currently being listed so new pages land under it by default.
 */
export function CreatePageListButton({ path }: { path: string }) {
  return (
    <CreatePageDialog
      defaultDir={path}
      trigger={
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground">
          <FilePlus className="h-3.5 w-3.5" />
          {m['header.create_page']()}
        </Button>
      }
    />
  );
}

/**
 * Empty-state entry point: a medium primary button shown inside the
 * `PageListEmptyCard` when a folder / portal has no child pages yet, so
 * there is always a way to create the first page under the current path.
 * Like `CreatePageListButton` it pre-fills the listed namespace.
 */
export function CreatePageCtaButton({ path }: { path: string }) {
  return (
    <CreatePageDialog
      defaultDir={path}
      trigger={
        <Button size="sm" className="gap-1.5">
          <FilePlus className="h-4 w-4" />
          {m['header.create_page']()}
        </Button>
      }
    />
  );
}
