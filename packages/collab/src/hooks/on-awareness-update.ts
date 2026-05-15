import type { onAwarenessUpdatePayload } from '@hocuspocus/server';
import Debug from 'debug';
import type { ContributorsTracker } from '../contributors';
import type { CollabContext } from '../types';

const debug = Debug('crowi:collab:awareness');

export interface OnAwarenessUpdateDeps {
  contributorsTracker: ContributorsTracker;
}

/**
 * Hocuspocus's `onAwarenessUpdate` fires when any connected client
 * publishes an awareness state delta. The payload's `states` array
 * carries every visible client's awareness fields — Phase 7 (browser
 * side) will set `awareness.setLocalStateField('user', { id, name })`
 * so the server can pluck `user.id` here.
 *
 * Phase 5 just feeds those ids into the contributors tracker. Phase 7
 * will land the matching client code; until then the tracker stays
 * empty during real WebSocket sessions, which means
 * `Revision.contributors` is filled only when a test explicitly
 * pre-populates awareness (see `__tests__/contributors.test.ts`).
 *
 * Defence:
 *   - States with no `user.id` are skipped (other awareness fields
 *     unrelated to user identity exist, e.g. cursors).
 *   - `documentName` is always the pageId (Hocuspocus's contract);
 *     we forward it verbatim — `record` short-circuits on empty
 *     args.
 */
export function createOnAwarenessUpdate(deps: OnAwarenessUpdateDeps) {
  return async (data: onAwarenessUpdatePayload<CollabContext>): Promise<void> => {
    const { documentName, states } = data;
    if (!Array.isArray(states) || states.length === 0) return;
    let added = 0;
    for (const state of states) {
      const user = (state as { user?: { id?: unknown } }).user;
      const idVal = user?.id;
      if (idVal === undefined || idVal === null) continue;
      const idStr = typeof idVal === 'string' ? idVal : String(idVal);
      if (idStr.length === 0) continue;
      deps.contributorsTracker.record(documentName, idStr);
      added += 1;
    }
    if (added > 0) debug('onAwarenessUpdate page=%s recorded=%d', documentName, added);
  };
}
