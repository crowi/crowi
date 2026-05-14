import type { onLoadDocumentPayload } from '@hocuspocus/server';
import * as Y from 'yjs';
import Debug from 'debug';
import type { CollabModels } from '../models';
import type { CollabContext } from '../types';
import { CONTENT_FIELD } from '../yjs-doc';

const debug = Debug('crowi:collab:load');

export interface OnLoadDocumentDeps {
  models: Pick<CollabModels, 'Page' | 'Revision'>;
}

/**
 * Build the Hocuspocus `onLoadDocument` hook.
 *
 * Restore order (per RFC-0003 §Phase 3):
 *
 *   1. If `Page.yjsState` is a non-empty Buffer, `Y.applyUpdate` it into
 *      `document`. This is the canonical fast path — checkpoints are
 *      written by `onStoreDocument` on every debounce window.
 *
 *   2. On `applyUpdate` throw (yjsState corruption) **or** when
 *      `yjsState` is null/empty, fall through to a fresh build:
 *      load the latest revision (`page.currentRevision ?? page.revision`,
 *      v1.x rows only have `revision`) and seed the Y.Text with its
 *      `body`. Empty body → empty Y.Doc (Y.Text.insert on '' is a
 *      no-op).
 *
 *   3. Revision missing (= newly created page that never got a revision)
 *      → return the empty Y.Doc untouched.
 *
 *   4. Page missing → throw. Hocuspocus terminates the connection.
 *      Should never happen at this stage because `onAuthenticate`
 *      already enforced page existence.
 */
export function createOnLoadDocument(deps: OnLoadDocumentDeps) {
  // Hocuspocus invokes the hook with the freshly-constructed Document
  // (a `Y.Doc` subclass). Mutating that doc in place + returning
  // `undefined` is the cheapest path: returning a separate `Y.Doc`
  // would trigger an extra `encodeStateAsUpdate` round-trip inside the
  // Hocuspocus core. See `packages/collab` src/server.ts for the
  // wrapper that adapts the void return to Hocuspocus's optional
  // `Doc | Uint8Array | undefined` signature.
  return async (data: onLoadDocumentPayload<CollabContext>): Promise<void> => {
    const { documentName, document } = data;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page = await (deps.models.Page as any).findById(documentName).select('_id revision currentRevision yjsState').exec();
    if (!page) {
      // Defensive — `onAuthenticate` already confirmed existence, so
      // this branch only fires on a race where the page was deleted
      // between auth and load.
      debug('page %s not found at load time', documentName);
      throw new Error('page not found');
    }

    // Path A — restore from the most recent checkpoint.
    const yjsState = page.yjsState as Buffer | null | undefined;
    if (yjsState && yjsState.length > 0) {
      try {
        Y.applyUpdate(document, new Uint8Array(yjsState));
        debug('restored page %s from yjsState (%d bytes)', documentName, yjsState.length);
        return;
      } catch (err) {
        // Phase 6 will broadcast `crowi:force-reload` here; Phase 3
        // logs and falls through to the body-seed fallback so a
        // corrupt yjsState doesn't lock out edits.
        console.warn(`[crowi:collab] yjsState for page ${String(documentName)} failed Y.applyUpdate; falling back to body seed.`, (err as Error).message);
      }
    }

    // Path B — fresh build from the latest revision's body.
    const revisionId = page.currentRevision ?? page.revision;
    if (revisionId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const revision = await (deps.models.Revision as any).findById(revisionId).select('body').lean().exec();
      if (revision && typeof revision.body === 'string' && revision.body.length > 0) {
        document.getText(CONTENT_FIELD).insert(0, revision.body);
        debug('seeded page %s from revision %s (%d chars)', documentName, revisionId, revision.body.length);
        return;
      }
    }

    debug('page %s loaded with empty Y.Doc (no revision body)', documentName);
  };
}
