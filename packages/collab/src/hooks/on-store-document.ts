import type { onStoreDocumentPayload } from '@hocuspocus/server';
import * as Y from 'yjs';
import Debug from 'debug';
import type { CollabModels } from '../models';
import type { CollabContext } from '../types';

const debug = Debug('crowi:collab:store');

export interface OnStoreDocumentDeps {
  models: Pick<CollabModels, 'Page'>;
}

/**
 * Build the Hocuspocus `onStoreDocument` hook.
 *
 * Phase 3 cadence: rely on Hocuspocus's default `debounce` / `maxDebounce`
 * (2s / 10s) to batch edits between checkpoints, then re-encode the
 * entire Y.Doc (`Y.encodeStateAsUpdate`) and overwrite `Page.yjsState`.
 * Phase 4 will layer `PageYjsUpdate` append + compaction on top of this
 * hook; the body of this function will grow but the entry point stays
 * the same.
 *
 * `lastContext.readonly` defence-in-depth: Hocuspocus refuses message
 * writes from a readonly connection at the protocol layer, so an
 * `onStoreDocument` invocation with `readonly: true` indicates an
 * upstream bug or version mismatch. We log + skip — never overwrite
 * `Page.yjsState` from a readonly context, which would clobber an
 * editor's in-flight work.
 */
export function createOnStoreDocument(deps: OnStoreDocumentDeps) {
  return async (data: onStoreDocumentPayload<CollabContext>): Promise<void> => {
    const { documentName, document, lastContext } = data;

    if (lastContext?.readonly) {
      console.warn(`[crowi:collab] onStoreDocument fired with readonly context for page ${String(documentName)} — skipping checkpoint.`);
      return;
    }

    const update = Y.encodeStateAsUpdate(document);
    const stateBuf = Buffer.from(update);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (deps.models.Page as any)
      .updateOne(
        { _id: documentName },
        {
          $set: {
            yjsState: stateBuf,
            yjsCheckpointAt: new Date(),
          },
        },
      )
      .exec();

    debug(
      'checkpointed page %s: %d bytes, matchedCount=%d, modifiedCount=%d',
      documentName,
      stateBuf.length,
      // Mongoose returns slightly different shapes depending on
      // driver version; cast for the log line only.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any).matchedCount ?? (result as any).n,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any).modifiedCount ?? (result as any).nModified,
    );
  };
}
