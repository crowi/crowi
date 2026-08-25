import type { PageHistoryEventRow as PageHistoryEvent, PageHistoryPayloadByKind } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

import { GrantChip } from '@/components/grant-chip';
import { UserAvatar } from '@/components/user-avatar';
import { formatDateTime, formatDistanceToNow } from '@/lib/date-utils';
import { grantLabel } from '@/lib/grant-label';

interface PageEventRowProps {
  event: PageHistoryEvent;
}

function eventMessage(event: PageHistoryEvent, actor: string) {
  switch (event.kind) {
    case 'page_created':
      return m['page_history.event_page_created']({ actor });
    case 'page_renamed':
      return m['page_history.event_page_renamed']({ actor });
    case 'visibility_changed':
      return m['page_history.event_visibility_changed']({ actor });
    case 'page_trashed':
      return m['page_history.event_page_trashed']({ actor });
    case 'page_restored':
      return m['page_history.event_page_restored']({ actor });
    case 'draft_published':
      return m['page_history.event_draft_published']({ actor });
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
  const actor = event.actor?.name ?? m['page_history.unknown_user']();
  const detail = eventDetail(event);

  return (
    <tr className="border-t bg-muted/20">
      <td colSpan={5} className="px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {event.actor && <UserAvatar user={event.actor} size="sm" />}
          <span>{eventMessage(event, actor)}</span>
          {event.subtree && (
            <span className="rounded-full border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{m['page_history.subtree_badge']()}</span>
          )}
          <span className="ml-auto text-xs text-muted-foreground" title={formatDateTime(event.occurredAt)}>
            {formatDistanceToNow(event.occurredAt)}
          </span>
        </div>
        {detail != null && (
          <div data-testid="event-detail" className="mt-1 flex min-w-0 items-center gap-2 text-sm text-muted-foreground" title={detail.title}>
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
          </div>
        )}
      </td>
    </tr>
  );
}
