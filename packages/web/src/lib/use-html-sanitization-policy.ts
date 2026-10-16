'use client';

import type { HtmlIframeOrigins, HtmlSanitizationPolicy } from '@crowi/api-contract/html-sanitizer';
import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { apiClient, resolveApiUrl } from './api-client';
import { API_TIMEOUT_MS } from './fetch-timeout';

export type HtmlSanitizationSnapshot = Readonly<{ policy: HtmlSanitizationPolicy; iframeOrigins?: HtmlIframeOrigins }>;

const STRICT: HtmlSanitizationSnapshot = Object.freeze({ policy: 'strict' });

/** Only a boolean `false` relaxes; anything else (missing, wrong type) stays strict. */
export function resolveHtmlSanitizationPolicy(value: unknown): HtmlSanitizationPolicy {
  return value === false ? 'relaxed' : 'strict';
}

function httpOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Builds the iframe origin exclusions from the same app-info response that
 * decided the policy. Any missing or malformed piece yields `undefined`, which
 * makes the sanitizer reject every iframe rather than guess an origin.
 */
function buildIframeOrigins(body: unknown): HtmlIframeOrigins | undefined {
  if (typeof window === 'undefined') return undefined;
  const delivery = typeof body === 'object' && body !== null ? (body as { artifactDelivery?: unknown }).artifactDelivery : undefined;
  if (typeof delivery !== 'object' || delivery === null) return undefined;
  const { enabled, origin } = delivery as { enabled?: unknown; origin?: unknown };
  if (typeof enabled !== 'boolean') return undefined;

  let artifactOrigin: string | null;
  if (origin === null) {
    if (enabled) return undefined;
    artifactOrigin = null;
  } else if (typeof origin === 'string') {
    const normalized = httpOrigin(origin);
    if (normalized === undefined) return undefined;
    artifactOrigin = normalized;
  } else {
    return undefined;
  }

  const webOrigin = httpOrigin(window.location.origin);
  const apiOrigin = httpOrigin(new URL(resolveApiUrl('/api/app/info'), window.location.origin).origin);
  if (webOrigin === undefined || apiOrigin === undefined) return undefined;
  return { webOrigin, apiOrigin, artifactOrigin };
}

/**
 * Fetches the public app-info once for one displayed view. The deadline covers
 * fetch AND body parsing: `fetchWithTimeout` stops its timer when headers
 * arrive, so a stalled body would otherwise leave the view waiting forever.
 * Rejection (timeout, abort, HTTP error, bad JSON) means the caller keeps strict.
 */
export function fetchHtmlSanitizationPolicy(signal: AbortSignal): Promise<HtmlSanitizationSnapshot> {
  return new Promise<HtmlSanitizationSnapshot>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const controller = new AbortController();
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      settle();
    };
    const onAbort = () => {
      controller.abort();
      finish(() => reject(new Error('aborted')));
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(() => reject(new Error('timeout')));
    }, API_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort);

    (async () => {
      const response = await apiClient.app.info.$get({}, { init: { cache: 'no-store', signal: controller.signal } });
      if (!response.ok) throw new Error('app info request failed');
      const body: unknown = await response.json();
      const policy = resolveHtmlSanitizationPolicy(
        typeof body === 'object' && body !== null ? (body as { htmlSanitizationEnabled?: unknown }).htmlSanitizationEnabled : undefined,
      );
      if (policy === 'strict') return STRICT;
      const iframeOrigins = buildIframeOrigins(body);
      return iframeOrigins ? { policy, iframeOrigins } : { policy };
    })().then(
      (snapshot) => finish(() => resolve(snapshot)),
      (error) => finish(() => reject(error)),
    );
  });
}

type ViewState = Readonly<{
  viewKey: string;
  generation: number;
  snapshot: HtmlSanitizationSnapshot;
  started: boolean;
  /** Set by a bfcache `pagehide` so the restored document refetches on `pageshow`. */
  suspended: boolean;
}>;

/**
 * The sanitization policy for one displayed view (mount + `viewKey`). Starts
 * strict and relaxes only after a fresh successful public app-info response
 * for the current generation; nothing is read from any shared cache.
 */
export function useHtmlSanitizationPolicy(viewKey: string, active = true): HtmlSanitizationSnapshot {
  const [state, setState] = useState<ViewState>(() => ({ viewKey, generation: 0, snapshot: STRICT, started: false, suspended: false }));

  // Derived-state reset during render so a new view never paints one frame
  // with the previous view's relaxed snapshot.
  let current = state;
  if (current.viewKey !== viewKey) {
    current = { viewKey, generation: current.generation + 1, snapshot: STRICT, started: false, suspended: false };
  }
  if (active && !current.started && !current.suspended) {
    current = { ...current, started: true };
  }
  if (current !== state) setState(current);

  const { generation, started } = current;

  useEffect(() => {
    if (!started) return;
    const controller = new AbortController();
    let stale = false;
    fetchHtmlSanitizationPolicy(controller.signal).then(
      (snapshot) => {
        if (stale) return;
        setState((s) => (s.generation === generation ? { ...s, snapshot } : s));
      },
      () => {},
    );
    return () => {
      stale = true;
      controller.abort();
    };
  }, [generation, started]);

  useEffect(() => {
    const onPageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      flushSync(() => setState((s) => ({ ...s, generation: s.generation + 1, snapshot: STRICT, started: false, suspended: true })));
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setState((s) => ({ ...s, suspended: false }));
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, []);

  return current.snapshot;
}
