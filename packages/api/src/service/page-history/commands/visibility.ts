import { Types } from 'mongoose';

import Crowi from 'src/crowi';
import { GRANT_PUBLIC, GRANTS } from 'src/models/page-grants';
import { runPageEventCommand, toPageHistoryEventSource } from '../page-event-command';
import type { PageCommandPlan, PageCommandSnapshot, PageEventCommandOutcome } from '../page-event-command';

/**
 * RFC-0021 §6.2/DC-2/DC-4 (Phase 2c-1) — the `visibility_changed` command.
 * `Page.updateGrant` (`models/page.ts`, DC-10) delegates its whole body here
 * so `PUT /pages/grant` and `updatePage`'s body+grant branch both go through
 * one CAS-and-event path.
 *
 * `expected`/`event` are computed from THIS call's `.lean()` snapshot only
 * (never from `input` alone) — `fromGrant`/`creator` must be the value
 * actually stored, not what the caller believes it to be, or a concurrent
 * winner's change would be silently overwritten by a stale CAS filter that
 * happens to still match (DC-2/F-8).
 */

export interface ChangeVisibilityInput {
  pageId: Types.ObjectId;
  toGrant: number;
  /** Also the `grantedUsers` rebuild input (deduped against the Page's `creator`). */
  actor: Types.ObjectId;
  /** Raw `editVia`/`authContext.kind` — converted to `PageHistoryEventSource` internally. */
  source?: string;
}

export async function changePageVisibility(crowi: Crowi, input: ChangeVisibilityInput): Promise<PageEventCommandOutcome> {
  const plan: PageCommandPlan = (snapshot: PageCommandSnapshot) => {
    const fromGrant = snapshot.grant ?? null;
    const creator = snapshot.creator ?? null;

    // Mirrors `Page.updateGrant`'s pre-delegation contract exactly (DC-2):
    // public grant clears `grantedUsers`; any other grant keeps the acting
    // user plus the Page's creator (deduped — an admin changing their own
    // page's grant must not double-list themselves).
    const grantedUsers: Types.ObjectId[] = [];
    if (input.toGrant !== GRANT_PUBLIC) {
      grantedUsers.push(input.actor);
      if (creator != null && String(creator) !== String(input.actor)) {
        grantedUsers.push(creator);
      }
    }

    // DC-4 — a Page whose stored `grant` isn't one of the 4 valid enum
    // values (a legacy `updatePage` bug's `grant: null` write, or any other
    // corruption) can never carry a truthful `fromGrant`. The state change
    // still applies; only the event is skipped.
    const fromGrantIsValid = fromGrant != null && (GRANTS as readonly number[]).includes(fromGrant);
    const event =
      fromGrantIsValid && fromGrant !== input.toGrant
        ? { kind: 'visibility_changed' as const, payload: { fromGrant: fromGrant as number, toGrant: input.toGrant } }
        : null;

    // Always `write`, never `noop` — even a same-grant call still rebuilds
    // `grantedUsers`, so there is always a domain-field change to apply,
    // just never an event when `fromGrant === toGrant`.
    return {
      decision: 'write',
      expected: { grant: fromGrant, creator },
      set: { grant: input.toGrant, grantedUsers },
      event,
    };
  };

  return runPageEventCommand(crowi, {
    pageId: input.pageId,
    actor: input.actor,
    source: toPageHistoryEventSource(input.source),
    plan,
  });
}
