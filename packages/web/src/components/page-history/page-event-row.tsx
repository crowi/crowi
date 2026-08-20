import type { PageHistoryEventRow as PageHistoryEvent } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

import { UserAvatar } from '@/components/user-avatar';
import { formatDateTime, formatDistanceToNow } from '@/lib/date-utils';

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

export function PageEventRow({ event }: PageEventRowProps) {
  const actor = event.actor?.name ?? m['page_history.unknown_user']();

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
      </td>
    </tr>
  );
}
