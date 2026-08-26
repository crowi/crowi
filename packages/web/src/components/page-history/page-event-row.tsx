import type { PageHistoryEventRow as PageHistoryEvent, PageHistoryPayloadByKind } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

import { GrantChip } from '@/components/grant-chip';
import { UserAvatar } from '@/components/user-avatar';
import { formatDateTime, formatHistoryDate } from '@/lib/date-utils';
import { grantLabel } from '@/lib/grant-label';

interface PageEventRowProps {
  event: PageHistoryEvent;
}

function eventMessage(event: PageHistoryEvent) {
  switch (event.kind) {
    case 'page_created':
      return m['page_history.event_page_created']();
    case 'page_renamed':
      return m['page_history.event_page_renamed']();
    case 'visibility_changed':
      return m['page_history.event_visibility_changed']();
    case 'page_trashed':
      return m['page_history.event_page_trashed']();
    case 'page_restored':
      return m['page_history.event_page_restored']();
    case 'draft_published':
      return m['page_history.event_draft_published']();
  }
}

interface TextEventDetail {
  kind: 'text';
  text: string;
  title: string;
  redirectCreated?: boolean;
}

interface VisibilityEventDetail {
  kind: 'visibility';
  fromGrant: number;
  toGrant: number;
  title: string;
}

type EventDetail = TextEventDetail | VisibilityEventDetail;

function eventDetail(event: PageHistoryEvent): EventDetail | null {
  if (event.payload == null || typeof event.payload !== 'object' || Array.isArray(event.payload)) return null;

  switch (event.kind) {
    case 'page_created':
    case 'draft_published':
      return null;
    case 'page_renamed': {
      const payload = event.payload as Partial<PageHistoryPayloadByKind['page_renamed']>;
      if (typeof payload.fromPath !== 'string' || typeof payload.toPath !== 'string' || typeof payload.redirectCreated !== 'boolean') {
        return null;
      }
      const text = m['page_history.detail_renamed']({ fromPath: payload.fromPath, toPath: payload.toPath });
      return { kind: 'text', text, title: text, redirectCreated: payload.redirectCreated };
    }
    case 'visibility_changed': {
      const payload = event.payload as Partial<PageHistoryPayloadByKind['visibility_changed']>;
      if (typeof payload.fromGrant !== 'number' || typeof payload.toGrant !== 'number') return null;
      const fromGrant = grantLabel(payload.fromGrant);
      const toGrant = grantLabel(payload.toGrant);
      if (fromGrant == null || toGrant == null) return null;
      const text = m['page_history.detail_visibility']({ fromGrant, toGrant });
      return { kind: 'visibility', fromGrant: payload.fromGrant, toGrant: payload.toGrant, title: text };
    }
    case 'page_trashed': {
      const payload = event.payload as Partial<PageHistoryPayloadByKind['page_trashed']>;
      if (typeof payload.fromPath !== 'string' || typeof payload.toPath !== 'string') return null;
      // The trash path is an internal storage location, not a useful destination for readers.
      const text = m['page_history.detail_trashed']({ path: payload.fromPath });
      return { kind: 'text', text, title: text };
    }
    case 'page_restored': {
      const payload = event.payload as Partial<PageHistoryPayloadByKind['page_restored']>;
      if (typeof payload.fromPath !== 'string' || typeof payload.toPath !== 'string') return null;
      const text = m['page_history.detail_restored']({ path: payload.toPath });
      return { kind: 'text', text, title: text };
    }
  }
}

export function PageEventRow({ event }: PageEventRowProps) {
  const actorName = event.actor?.name ?? m['page_history.unknown_user']();
  const actor = event.actor ?? { name: actorName, username: 'unknown-user', image: null };
  const detail = eventDetail(event);

  return (
    <tr className="border-t text-xs text-muted-foreground">
      {/* Separate empty selection cells preserve the radio lanes through audit-only rows. */}
      <td className="px-3 py-2 text-center" />
      <td className="px-3 py-2 text-center" />
      <td className="min-w-0 px-3 py-2">
        <div className="flex w-0 min-w-full items-center gap-2 whitespace-nowrap">
          <UserAvatar user={actor} size="xs" />
          <span className="shrink-0">{actorName}</span>
          <span className="shrink-0">{eventMessage(event)}</span>
          {event.subtree && (
            <span className="rounded-full border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{m['page_history.subtree_badge']()}</span>
          )}
          {detail != null && (
            <span data-testid="event-detail" className="flex min-w-0 flex-1 items-center gap-2" title={detail.title}>
              {detail.kind === 'visibility' ? (
                <>
                  <GrantChip grant={detail.fromGrant} publicTreatment="muted" />
                  <span aria-hidden="true">→</span>
                  <GrantChip grant={detail.toGrant} publicTreatment="muted" />
                </>
              ) : (
                <span data-testid="event-detail-text" className="min-w-0 truncate whitespace-nowrap" title={detail.title}>
                  {detail.text}
                </span>
              )}
              {detail.kind === 'text' && detail.redirectCreated && (
                <span className="shrink-0 rounded-full border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {m['page_history.redirect_badge']()}
                </span>
              )}
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2">
        <span title={formatDateTime(event.occurredAt)}>{formatHistoryDate(event.occurredAt)}</span>
      </td>
      <td className="px-3 py-2" />
    </tr>
  );
}
