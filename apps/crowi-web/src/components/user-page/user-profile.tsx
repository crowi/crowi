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
    <header className="relative -mx-4 -mt-8 mb-8">
      <div
        aria-hidden="true"
        className="h-32 md:h-40 rounded-b-2xl relative overflow-hidden bg-muted/30"
        style={{
          // Default cover: aurora-style mesh built from the Crowi avatar
          // palette (primary teal, sage, gold, coral) plus the dark
          // header tint as a depth anchor. Each colour drops in at low
          // opacity so the band reads as "atmosphere with warmth"
          // rather than a rainbow.
          backgroundImage: [
            // Primary teal — top-right anchor (brand foothold)
            'radial-gradient(ellipse 80% 110% at 100% 0%, color-mix(in srgb, var(--crowi-primary) 78%, transparent), transparent 60%)',
            // Sage — bottom-left/center glow
            'radial-gradient(ellipse 70% 110% at 25% 115%, color-mix(in srgb, #8eb39b 70%, transparent), transparent 62%)',
            // Gold — top-left morning light
            'radial-gradient(ellipse 60% 90% at 0% 0%, color-mix(in srgb, #f0d264 55%, transparent), transparent 60%)',
            // Coral — bottom-right kiss of warmth
            'radial-gradient(ellipse 50% 80% at 100% 110%, color-mix(in srgb, #d96d68 48%, transparent), transparent 62%)',
            // Header dark — top vignette for depth
            'radial-gradient(ellipse 70% 50% at 50% -10%, color-mix(in srgb, var(--crowi-header) 30%, transparent), transparent 70%)',
          ].join(', '),
        }}
      >
        {/* Paper grain — SVG turbulence as data URL, blended in with
            multiply so it darkens highlights but barely touches shadows.
            Tile at 160px so the noise doesn't read as a pattern. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 mix-blend-multiply opacity-[0.18]"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
            backgroundSize: '160px 160px',
          }}
        />

        {/* Top accent hairline — Crowi primary at 60%, gives the band
            its "lip" without a heavy frame. */}
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
