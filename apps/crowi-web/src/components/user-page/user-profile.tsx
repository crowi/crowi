'use client';

import { Bookmark, FileText } from 'lucide-react';
import { UserAvatar } from '@/components/user-avatar';
import type { UserPublic } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

interface UserProfileProps {
  user: UserPublic;
  createdPagesCount: number;
  bookmarksCount: number;
}

/**
 * Magazine-cover style profile header. The cover band is full-bleed
 * (negative margin against the layout's `px-4`) so the green gradient
 * reaches the page edge; the avatar then steps back to the content
 * column and overlaps the cover's bottom edge.
 */
export function UserProfile({ user, createdPagesCount, bookmarksCount }: UserProfileProps) {
  const displayName = user.name || user.username;

  return (
    <header className="relative -mx-4 mb-8">
      <div
        aria-hidden="true"
        className="h-32 md:h-40 rounded-b-2xl relative overflow-hidden"
        style={{
          background:
            'linear-gradient(135deg, color-mix(in srgb, var(--crowi-primary) 18%, transparent) 0%, color-mix(in srgb, var(--crowi-primary) 6%, transparent) 45%, transparent 100%)',
        }}
      >
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-[0.05] text-foreground"
          style={{
            backgroundImage: 'radial-gradient(circle, currentColor 1px, transparent 1px)',
            backgroundSize: '22px 22px',
          }}
        />
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-px" style={{ background: 'color-mix(in srgb, var(--crowi-primary) 60%, transparent)' }} />
      </div>

      <div className="px-4 -mt-12 md:-mt-14 relative">
        <div className="flex items-end gap-5 flex-wrap">
          <UserAvatar user={user} size="lg" className="ring-4 ring-background shadow-md flex-shrink-0" />
          <div className="flex-1 min-w-0 pb-1.5">
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight leading-tight text-foreground">{displayName}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground font-mono">@{user.username}</p>
          </div>
        </div>

        {user.introduction && <p className="mt-5 max-w-2xl text-foreground/85 leading-relaxed whitespace-pre-wrap">{user.introduction}</p>}

        <dl className="mt-6 flex flex-wrap items-center gap-x-7 gap-y-2 text-sm text-muted-foreground">
          <div className="inline-flex items-center gap-1.5">
            <FileText className="h-4 w-4" aria-hidden="true" />
            <dt className="sr-only">{m['user_page.tab_pages']()}</dt>
            <dd>
              <span className="font-semibold text-foreground tabular-nums">{createdPagesCount}</span>
              <span className="ml-1">{m['user_page.stat_pages_label']()}</span>
            </dd>
          </div>
          <div className="inline-flex items-center gap-1.5">
            <Bookmark className="h-4 w-4" aria-hidden="true" />
            <dt className="sr-only">{m['user_page.tab_bookmarks']()}</dt>
            <dd>
              <span className="font-semibold text-foreground tabular-nums">{bookmarksCount}</span>
              <span className="ml-1">{m['user_page.stat_bookmarks_label']()}</span>
            </dd>
          </div>
        </dl>
      </div>
    </header>
  );
}
