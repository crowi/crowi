'use client';

import { useEffect, useRef } from 'react';
import { resolveApiUrl } from '@/lib/api-client';
import { useAppInfo } from '@/lib/use-app-info';

const LINK_MARKER_ATTR = 'data-crowi-renderer-stylesheet';

interface ManagedLink {
  el: HTMLLinkElement;
  /** How many mounted `RendererStylesheets` instances currently want this href. */
  refCount: number;
}

/**
 * Module-level (not per-instance) so multiple mounted `RendererStylesheets`
 * — today there is exactly one, in the `(auth)` shell, but React Strict
 * Mode's dev double-invoke or a future second mount point should not
 * double-insert or prematurely remove a shared `<link>` — share one DOM
 * node per resolved href and only remove it once every owner has released
 * it.
 */
const managedLinks = new Map<string, ManagedLink>();

function acquire(href: string, sourcePath: string): void {
  const existing = managedLinks.get(href);
  if (existing) {
    existing.refCount += 1;
    return;
  }
  const el = document.createElement('link');
  el.rel = 'stylesheet';
  el.href = href;
  // The ORIGINAL API-relative manifest path (not the resolved href) — a
  // stable identifier across an origin change, useful for spotting a
  // renderer stylesheet tag in devtools.
  el.setAttribute(LINK_MARKER_ATTR, sourcePath);
  // Deliberately NO `onload` / `onerror` handler: this component is
  // strictly fail-open (spec §2.1) — a stylesheet request that never
  // resolves (network down, blocked, a plugin's route 404s) must never
  // gate rendering. The browser's own devtools network/console panel is
  // the only surface for noticing a broken plugin stylesheet path.
  document.head.appendChild(el);
  managedLinks.set(href, { el, refCount: 1 });
}

function release(href: string): void {
  const existing = managedLinks.get(href);
  if (!existing) return;
  existing.refCount -= 1;
  if (existing.refCount <= 0) {
    existing.el.remove();
    managedLinks.delete(href);
  }
}

/**
 * Renders nothing. Side-effect-only client component (same pattern as
 * `ThemeSync` / `LocaleSync`) that keeps `document.head` in sync with the
 * `rendererStylesheets` manifest from `GET /api/app/info` — the
 * boot-time CSS assets renderer plugins registered via
 * `RendererRegistry.addStylesheet(path)` (feature-renderer-plugin-boundary
 * Phase 1, `packages/api/src/renderer/registry.ts`).
 *
 * Strictly fail-open / non-blocking by design:
 *   - Shares `useAppInfo()`'s query (5-minute stale, no focus refetch) —
 *     no dedicated fetch, no loading state of its own.
 *   - Renders `null` unconditionally and on every render — it never
 *     withholds the auth shell / its siblings while the manifest is
 *     still loading or a stylesheet request is in flight.
 *   - Never attaches `load` / `error` listeners to the injected `<link>`s
 *     (see `acquire` above) — a black-holed CSS request has no observable
 *     effect on this component or anything it's mounted next to.
 *
 * Diffs the manifest's resolved hrefs against what THIS instance
 * currently has mounted (`mountedHrefsRef`) so an unrelated manifest
 * change (or a same-content refetch, which still yields a new array
 * reference from `useQuery`) only inserts/removes the hrefs that actually
 * changed — every href present in both the old and new manifest keeps its
 * live `<link>` untouched. `acquire`/`release` ref-count the shared
 * `managedLinks` map so concurrent instances (or a fast remount) never
 * double-insert or drop another owner's link.
 */
export function RendererStylesheets(): null {
  const { data } = useAppInfo();
  const rendererStylesheets = data?.rendererStylesheets;
  const mountedHrefsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const nextHrefs = new Map((rendererStylesheets ?? []).map((path) => [resolveApiUrl(path), path] as const));
    const prevHrefs = mountedHrefsRef.current;

    for (const [href, path] of nextHrefs) {
      if (!prevHrefs.has(href)) acquire(href, path);
    }
    for (const href of prevHrefs) {
      if (!nextHrefs.has(href)) release(href);
    }
    mountedHrefsRef.current = new Set(nextHrefs.keys());
  }, [rendererStylesheets]);

  // Unmount-only cleanup: release every href THIS instance currently
  // holds (a separate effect with an empty dep array — not the effect
  // above's own cleanup — so a manifest update doesn't churn the DOM: the
  // effect above already handles incremental diffing on every render,
  // this one only fires once, on unmount).
  useEffect(() => {
    return () => {
      for (const href of mountedHrefsRef.current) release(href);
      mountedHrefsRef.current = new Set();
    };
  }, []);

  return null;
}
