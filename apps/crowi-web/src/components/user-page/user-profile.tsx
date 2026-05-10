'use client';

import type { ReactNode } from 'react';
import { Bookmark, FileText } from 'lucide-react';
import { UserAvatar } from '@/components/user-avatar';
import type { UserPublic } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

export type UserProfileTab = 'pages' | 'bookmarks';

interface UserProfileProps {
  user: UserPublic;
  createdPagesCount: number;
  bookmarksCount: number;
  /** Invoked when a stat pill is clicked. Caller scrolls + switches the footer tab. */
  onStatClick?: (tab: UserProfileTab) => void;
}

/**
 * Magazine-cover style profile header. The cover band is full-bleed
 * (negative margin against the layout's `px-4`) so the green gradient
 * reaches the page edge; the avatar then steps back to the content
 * column and overlaps the cover's bottom edge.
 */
export function UserProfile({ user, createdPagesCount, bookmarksCount, onStatClick }: UserProfileProps) {
  const displayName = user.name || user.username;

  return (
    <header className="relative -mx-4 -mt-8 mb-8">
      <div
        aria-hidden="true"
        className="h-32 md:h-40 rounded-b-2xl relative overflow-hidden"
        style={{
          // Aurora mesh built from the Crowi avatar palette (primary
          // teal #43676b / sage #8eb39b / gold #f0d264 / coral #d96d68)
          // plus the dark header tint #263a3c. Hand-coded rgba() —
          // some color-mix() pipelines were producing barely-visible
          // results in dev. Stops pushed out to 95%+ so the colour
          // covers more of the band than just the corner spots.
          backgroundImage: [
            'radial-gradient(ellipse 90% 130% at 100% 0%, rgba(67, 103, 107, 0.85), transparent 95%)',
            'radial-gradient(ellipse 80% 130% at 20% 110%, rgba(142, 179, 155, 0.75), transparent 95%)',
            'radial-gradient(ellipse 65% 100% at 0% 0%, rgba(240, 210, 100, 0.60), transparent 90%)',
            'radial-gradient(ellipse 55% 90% at 100% 110%, rgba(217, 109, 104, 0.55), transparent 90%)',
            'radial-gradient(ellipse 80% 60% at 50% -10%, rgba(38, 58, 60, 0.30), transparent 80%)',
          ].join(', '),
        }}
      >
        {/* Grayscale paper grain — SVG turbulence converted to luma
            so it doesn't shift the gradient hue. Multiply at low
            opacity adds tactility without flattening the colour. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 mix-blend-multiply opacity-[0.10]"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0 0 0 1 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
            backgroundSize: '160px 160px',
          }}
        />

        {/* Top accent hairline — Crowi primary at 60%, gives the band
            its "lip" without a heavy frame. */}
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-px" style={{ background: 'color-mix(in srgb, var(--crowi-primary) 60%, transparent)' }} />
      </div>

      <div className="px-4 relative">
        {/* Avatar + display name share the cover edge. `mb-5` on the
            h1 itself opens breathing room below the name. */}
        <div className="-mt-12 md:-mt-14 flex items-center gap-4 flex-wrap">
          <UserAvatar user={user} size="lg" className="ring-4 ring-background shadow-md flex-shrink-0" />
          <h1 className="mb-5 text-3xl md:text-4xl font-bold tracking-tight leading-tight text-foreground min-w-0">{displayName}</h1>
        </div>

        {/* Below the cover. `ml-24` = avatar w-20 (80px) + gap-4 (16px)
            so @username / stats / intro line up with the display name's
            left edge. `mt-[-12px]` pulls the sub-block up to sit close
            to the name without colliding with the cover. */}
        <div className="ml-24 mt-[-12px]">
          <p className="text-sm text-muted-foreground font-mono">@{user.username}</p>

          <div className="-ml-2.5 mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
            <StatButton
              icon={<FileText className="h-3.5 w-3.5" aria-hidden="true" />}
              count={createdPagesCount}
              label={m['user_page.stat_pages_label']()}
              ariaLabel={m['user_page.tab_pages']()}
              onClick={onStatClick ? () => onStatClick('pages') : undefined}
            />
            <StatButton
              icon={<Bookmark className="h-3.5 w-3.5" aria-hidden="true" />}
              count={bookmarksCount}
              label={m['user_page.stat_bookmarks_label']()}
              ariaLabel={m['user_page.tab_bookmarks']()}
              onClick={onStatClick ? () => onStatClick('bookmarks') : undefined}
            />
          </div>

          {user.introduction && <p className="mt-5 max-w-2xl text-foreground/85 leading-relaxed whitespace-pre-wrap">{user.introduction}</p>}
        </div>
      </div>
    </header>
  );
}

interface StatButtonProps {
  icon: ReactNode;
  count: number;
  label: string;
  ariaLabel: string;
  onClick?: () => void;
}

/**
 * Pill-style stat shown under @username. When `onClick` is provided
 * the row becomes a button; otherwise it stays as plain text so the
 * profile reads correctly even if the consumer doesn't hook up the
 * scroll-to-tabs behaviour.
 */
function StatButton({ icon, count, label, ariaLabel, onClick }: StatButtonProps) {
  const content = (
    <>
      {icon}
      <span className="font-semibold text-foreground tabular-nums">{count}</span>
      <span className="text-muted-foreground">{label}</span>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 hover:bg-foreground/5 active:bg-foreground/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {content}
      </button>
    );
  }

  return <span className="inline-flex items-center gap-1.5 px-2.5 py-1">{content}</span>;
}
