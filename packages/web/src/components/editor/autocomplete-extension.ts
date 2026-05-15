import { autocompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import { apiClient } from '@/lib/api-client';
import { AutocompleteCache, type AutocompleteKind } from '@/lib/autocomplete-cache';
import type { AutocompleteResult } from '@crowi/api-contract';

/**
 * RFC-0004 Phase 5 — CodeMirror 6 autocomplete extension for the editor.
 *
 * Drives two dropdowns:
 *   - `@<char>` → user-mention completion, inserts `@username`.
 *   - `[[<char>+` → wikilink completion, inserts `[[/full/path]]`
 *     (closing brackets included).
 *
 * The heavy lifting (the dropdown UI, ARIA combobox semantics, arrow-key
 * navigation, Escape / outside-click dismissal) is provided by
 * `@codemirror/autocomplete`; this module contributes the two
 * `CompletionSource`s plus the trigger / suppression / cancellation
 * rules from `docs/rfcs/0004-editor-ux-enhancement.md` §"Autocomplete".
 *
 * Pure helpers (`detectTrigger`, `isSuppressedContext`, `isMobileWidth`)
 * are exported so the trigger / suppression logic is unit-testable
 * without mounting an editor.
 */

/** Username characters per RFC: alphanumeric, `_`, `-`. */
const USERNAME_CHAR = /[A-Za-z0-9_-]/;

/** Characters that may precede a trigger: start-of-line / whitespace / punctuation. */
const TRIGGER_PRECEDING = /[\s([{<"'`*~]/;

/** Mobile-viewport cutoff — autocomplete is disabled below this width. */
const MOBILE_MAX_WIDTH = 768;

/** Debounce before a source actually queries the server. */
const DEBOUNCE_MS = 100;

/** Server-side / client-side candidate cap. */
const RESULT_LIMIT = 10;

/** A detected autocomplete trigger and the query typed after it. */
export interface TriggerMatch {
  kind: AutocompleteKind;
  /** The query text after the trigger (`@a` → `a`, `[[ap` → `ap`). */
  query: string;
  /** Absolute document offset where the trigger token starts. */
  from: number;
}

/**
 * Inspect the text before `pos` and decide whether an autocomplete
 * trigger is active.
 *
 *   - User (`@`): the `@` must be preceded by start-of-line, whitespace
 *     or punctuation (so `user@example.com` does NOT trigger), and at
 *     least one username character must follow it. Bare `@` (the start
 *     of the `@[card]` embed syntax) does not trigger because `[` is
 *     not a username character.
 *   - Page (`[[`): both brackets must be typed in sequence and at
 *     least one character must follow. The `[[` must be preceded by
 *     start-of-line, whitespace or punctuation.
 *
 * Returns `null` when no trigger is active.
 */
export function detectTrigger(textBefore: string): TriggerMatch | null {
  // --- Wikilink `[[query` ---
  // Find the last `[[` and check everything after it is query text.
  const lastOpen = textBefore.lastIndexOf('[[');
  if (lastOpen >= 0) {
    const query = textBefore.slice(lastOpen + 2);
    // The query must not contain `]` (a `]` closes the link, ending
    // the sequence) or a newline, and must be non-empty.
    if (query.length >= 1 && !query.includes(']') && !query.includes('\n') && !query.includes('[')) {
      const preceding = lastOpen === 0 ? '' : textBefore[lastOpen - 1];
      if (preceding === '' || TRIGGER_PRECEDING.test(preceding)) {
        return { kind: 'page', query, from: lastOpen };
      }
    }
  }

  // --- User mention `@query` ---
  const lastAt = textBefore.lastIndexOf('@');
  if (lastAt >= 0) {
    const query = textBefore.slice(lastAt + 1);
    // Every character after `@` must be a valid username character and
    // there must be at least one (bare `@` does not trigger).
    if (query.length >= 1 && [...query].every((ch) => USERNAME_CHAR.test(ch))) {
      const preceding = lastAt === 0 ? '' : textBefore[lastAt - 1];
      if (preceding === '' || TRIGGER_PRECEDING.test(preceding)) {
        return { kind: 'user', query, from: lastAt };
      }
    }
  }

  return null;
}

/**
 * True when `pos` sits inside a context where autocomplete must be
 * suppressed: fenced or inline code, math (`$$`), or the label / URL
 * portion of a `[text](url)` link. Detected via CodeMirror's syntax
 * tree so it tracks the markdown grammar rather than re-parsing text.
 */
export function isSuppressedContext(state: EditorState, pos: number): boolean {
  // Walk the syntax-tree node stack at `pos`. `resolveInner` gives the
  // innermost node; climbing parents covers nested structures.
  let node = syntaxTree(state).resolveInner(pos, -1);
  while (node) {
    const name = node.name;
    if (
      // Fenced + inline code.
      name === 'FencedCode' ||
      name === 'CodeBlock' ||
      name === 'CodeText' ||
      name === 'InlineCode' ||
      // KaTeX / math (lang-markdown math extension emits these when
      // configured; harmless to check unconditionally).
      name === 'Math' ||
      name === 'BlockMath' ||
      name === 'InlineMath' ||
      // Link label / URL portions of `[text](url)`.
      name === 'URL' ||
      name === 'Link' ||
      name === 'Image'
    ) {
      return true;
    }
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}

/** Viewport-width heuristic for "this is a mobile device". */
export function isMobileWidth(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < MOBILE_MAX_WIDTH;
}

/** Module-scoped cache shared by all editor instances in the tab. */
const cache = new AutocompleteCache<AutocompleteResult[]>();

/**
 * Set of `(kind, query)` keys whose next lookup must bypass the cache.
 * The "Refresh results" footer marks the active query here; the source
 * clears the mark after the forced re-query so subsequent keystrokes
 * cache normally again.
 */
const refreshRequests = new Set<string>();
const refreshKey = (kind: AutocompleteKind, query: string) => `${kind}::${query.toLowerCase()}`;

/** Query the autocomplete endpoint for `kind`, honouring the LRU cache. */
async function fetchResults(kind: AutocompleteKind, query: string): Promise<AutocompleteResult[]> {
  const key = refreshKey(kind, query);
  const bypassCache = refreshRequests.has(key);

  if (!bypassCache) {
    const cached = cache.get(kind, query);
    if (cached) return cached;
  } else {
    refreshRequests.delete(key);
    cache.invalidate(kind, query);
  }

  try {
    const response =
      kind === 'user'
        ? await apiClient.autocomplete.autocompleteUsers({ query: { q: query, limit: RESULT_LIMIT } })
        : await apiClient.autocomplete.autocompletePages({ query: { q: query, limit: RESULT_LIMIT } });

    if (response.status !== 200) {
      // 429 / 400 / 401 → behave as "zero results"; the dropdown
      // closes silently (RFC §"Cancellation conditions").
      return [];
    }
    const results = response.body.results;
    cache.set(kind, query, results);
    return results;
  } catch {
    // Network failure → silent close, same as zero results.
    return [];
  }
}

/**
 * Build a CodeMirror `Completion` for a result. The `apply` string is
 * the canonical Markdown insertion: `@username` for users, the full
 * `[[/path]]` (closing brackets included) for pages.
 */
function toCompletion(kind: AutocompleteKind, result: AutocompleteResult): Completion {
  if (kind === 'user') {
    return {
      label: result.display,
      apply: `@${result.label}`,
      type: 'user',
    };
  }
  return {
    label: result.display,
    apply: `[[${result.label}]]`,
    type: 'page',
  };
}

/**
 * Footer option that re-queries the server bypassing the LRU cache.
 * Rendered as the last row of the dropdown; selecting it marks the
 * active query for a forced refresh and re-opens completion.
 */
function refreshOption(kind: AutocompleteKind, query: string): Completion {
  return {
    label: 'Refresh results',
    type: 'refresh',
    // `apply` as a function: instead of inserting text, mark the query
    // for a cache-bypass and re-trigger completion at the same spot.
    apply: (view) => {
      refreshRequests.add(refreshKey(kind, query));
      // Re-dispatch a no-op so the autocompletion plugin recomputes.
      view.dispatch({});
      // Programmatically reopen the dropdown.
      import('@codemirror/autocomplete').then(({ startCompletion }) => startCompletion(view));
    },
  };
}

/**
 * The shared completion source. CodeMirror calls this on every edit /
 * explicit trigger; it returns `null` to mean "no completion here".
 */
const completionSource: CompletionSource = async (context: CompletionContext): Promise<CompletionResult | null> => {
  // Mobile suppression — autocomplete is keyboard-centric and the
  // dropdown overlaps the on-screen keyboard.
  if (isMobileWidth()) return null;

  const { state, pos } = context;
  const line = state.doc.lineAt(pos);
  const textBefore = line.text.slice(0, pos - line.from);

  const trigger = detectTrigger(textBefore);
  if (!trigger) return null;

  // Suppression: code / math / link syntax.
  if (isSuppressedContext(state, pos)) return null;

  // Absolute offset where the trigger token begins.
  const tokenFrom = line.from + trigger.from;

  const results = await fetchResults(trigger.kind, trigger.query);

  // Zero results → return null so the dropdown simply closes; no
  // "no results" UI (RFC §"Cancellation conditions").
  if (results.length === 0) return null;

  const options: Completion[] = results.slice(0, RESULT_LIMIT).map((r) => toCompletion(trigger.kind, r));
  // Footer affordance to bypass the LRU cache.
  options.push(refreshOption(trigger.kind, trigger.query));

  return {
    from: tokenFrom,
    to: pos,
    options,
    // We rank server-side; don't let CodeMirror re-filter / re-sort the
    // server order (the refresh footer must also stay last).
    filter: false,
  };
};

/**
 * The autocomplete extension to thread through `extraExtensions`.
 *
 * `activateOnTyping` keeps the dropdown keyboard-driven (paste does not
 * fire `autocompletion`'s typing activation, so pasted text never opens
 * the dropdown — RFC requirement). The 100 ms `activateOnTypingDelay`
 * is the RFC's debounce.
 */
export function autocompleteExtension(): Extension {
  return autocompletion({
    override: [completionSource],
    activateOnTyping: true,
    activateOnTypingDelay: DEBOUNCE_MS,
    closeOnBlur: true,
    // Single-row footer aside, results are already capped at 10.
    maxRenderedOptions: RESULT_LIMIT + 1,
    icons: false,
  });
}

/** Test-only: reset module-scoped cache + refresh marks between cases. */
export function __resetAutocompleteState(): void {
  cache.clear();
  refreshRequests.clear();
}
