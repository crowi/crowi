import { Server } from '@hocuspocus/server';
import Debug from 'debug';
import type { CollabModels } from './models';
import type { CollabContext } from './types';
import type { CollabWsTokenUtil } from './ws-token';
import { createOnAuthenticate, type OnAuthenticateDeps } from './hooks/on-authenticate';
import { createOnLoadDocument } from './hooks/on-load-document';
import { createOnStoreDocument } from './hooks/on-store-document';
import { createOnChange } from './hooks/on-change';
import { createCompactor } from './compaction';

const debug = Debug('crowi:collab:server');

export interface CreateCollabServerOptions {
  models: CollabModels;
  wsTokenUtil: CollabWsTokenUtil;
  /** Port for the Hocuspocus HTTP/WebSocket server. Tests pass `0` for ephemeral. */
  port: number;
  /** Bind address. Defaults to `0.0.0.0`. */
  address?: string;
  /** Silence Hocuspocus's start screen — true in production / tests. */
  quiet?: boolean;
  /**
   * Hocuspocus `debounce` (ms). Tests pass a small value so
   * `onStoreDocument` fires before `disconnect`+await completes;
   * production keeps the default 2000 ms.
   */
  debounce?: number;
  /** Hocuspocus `maxDebounce` (ms). Tests pass a small value. */
  maxDebounce?: number;
  /**
   * Override the cap check (Phase 6 swaps the Redis-backed
   * implementation in via this seam). Defaults to the stub from the
   * api dist.
   */
  checkEditorCap?: OnAuthenticateDeps['checkEditorCap'];
}

/**
 * Build a Hocuspocus `Server` wired to Crowi's models. Listen is
 * separate (`server.listen()`) so callers can inspect the address
 * before / after binding — especially useful in tests that need to
 * discover the random port.
 *
 * Server-level `stopOnSignals: false` because the parent
 * `startCollabServer` (in `index.ts`) registers its own graceful
 * shutdown that also disconnects Mongoose. Letting Hocuspocus call
 * `process.exit(0)` would skip the mongoose teardown.
 *
 * Phase 4 wires the `onChange` firehose + a single shared `compactor`
 * across both `onChange` (count trigger) and `onStoreDocument` (time
 * trigger + debounce-driven checkpoint). Sharing the compactor is
 * load-bearing: its in-memory `inflight` Set is what de-duplicates
 * a count-trigger compaction racing a store-trigger checkpoint for
 * the same page.
 */
export function createCollabServer(opts: CreateCollabServerOptions): Server<CollabContext> {
  const { models, wsTokenUtil, port, address, quiet, debounce, maxDebounce, checkEditorCap } = opts;

  const compactor = createCompactor({
    models: { Page: models.Page, PageYjsUpdate: models.PageYjsUpdate },
  });

  const onAuthenticate = createOnAuthenticate({
    wsTokenUtil,
    models: { Page: models.Page },
    checkEditorCap,
  });
  const onLoadDocument = createOnLoadDocument({
    models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
  });
  const onStoreDocument = createOnStoreDocument({
    models: { Page: models.Page },
    compactor,
  });
  const onChange = createOnChange({
    models: { PageYjsUpdate: models.PageYjsUpdate },
    compactor,
  });

  const server = new Server<CollabContext>({
    name: 'crowi-collab',
    port,
    address: address ?? '0.0.0.0',
    quiet: quiet ?? false,
    debounce: debounce ?? 2000,
    maxDebounce: maxDebounce ?? 10000,
    // Pin Hocuspocus's v4 default explicitly so a future upgrade
    // can't silently flip it. Collab is a long-running worker and
    // we want every idle Y.Doc released as soon as its last client
    // disconnects — otherwise active-page count drives memory.
    unloadImmediately: true,
    // Crowi's parent index.ts owns SIGINT/SIGTERM so it can disconnect
    // mongoose before `process.exit(0)`.
    stopOnSignals: false,
    async onAuthenticate(payload) {
      return onAuthenticate(payload);
    },
    async onLoadDocument(payload) {
      await onLoadDocument(payload);
    },
    async onChange(payload) {
      await onChange(payload);
    },
    async onStoreDocument(payload) {
      await onStoreDocument(payload);
    },
  });

  debug('collab server constructed (port=%d, debounce=%d/%d)', port, debounce ?? 2000, maxDebounce ?? 10000);
  return server;
}
