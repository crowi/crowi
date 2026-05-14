'use client';

import { useEffect, useMemo, useState } from 'react';
import { UserAvatar } from '@/components/user-avatar';
import { useAwarenessStates, type AwarenessState } from '@/lib/use-awareness-states';
import type { CollabAwareness } from '@/lib/use-collab-document';

/**
 * Threshold for the typing-indicator overlay (RFC-0003 §Phase 8.5).
 *
 * Peers tag their awareness state with `typingAt` (ms timestamp) on
 * every Y.Text mutation. We surface the bouncing-dots overlay when
 * `Date.now() - typingAt < ACTIVE_MS`. The 3 s window matches the
 * cadence at which `setLocalAwareness` re-publishes the timestamp on
 * sustained typing — short enough to feel responsive when someone
 * stops, long enough to bridge keystroke gaps without flicker.
 */
const TYPING_ACTIVE_MS = 3_000;

interface CollabPresenceAvatarsProps {
  awareness: CollabAwareness | null;
  /**
   * The local client's awareness id (= `awareness.clientID`). Passed
   * explicitly so the avatar group filters self out without poking at
   * the awareness instance through props.
   */
  localClientId: number | null | undefined;
  className?: string;
}

/**
 * Header-right presence indicator: stacks every remote peer's avatar
 * with their cursor color as a border (so it visually ties back to the
 * caret painted by yCollab). Active typists get a bouncing-dots overlay
 * driven by `typingAt`.
 *
 * Renders `null` when no remote peers are connected — the header should
 * stay clean in the single-user case.
 */
export function CollabPresenceAvatars({ awareness, localClientId, className }: CollabPresenceAvatarsProps) {
  const states = useAwarenessStates(awareness);

  // 1 Hz tick so the typing overlay clears within ~1 s of someone
  // going idle. We only spin the interval when at least one peer
  // currently has a `typingAt` timestamp — single-user editing pays
  // zero timer overhead. `hasTypist` is recomputed inline (not memo'd)
  // because the input `states` already reshapes on every awareness
  // event; an extra useMemo would just add work.
  let hasTypist = false;
  for (const [, state] of states) {
    if (typeof state.typingAt === 'number') {
      hasTypist = true;
      break;
    }
  }
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!hasTypist) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [hasTypist]);

  const peers = useMemo(() => {
    const out: Array<{ clientId: number; user: NonNullable<AwarenessState['user']>; typing: boolean }> = [];
    const seenIds = new Set<string>();
    for (const [clientId, state] of states) {
      if (clientId === localClientId) continue;
      const user = state.user;
      if (!user) continue;
      // Same account in two windows / devices: dedup so the header
      // doesn't show "Alice, Alice". Keep the first encounter (the
      // typing state below merges across all dedup'd entries).
      const accountKey = user.id ?? user.username ?? `client-${clientId}`;
      if (seenIds.has(accountKey)) continue;
      seenIds.add(accountKey);

      const typingAt = typeof state.typingAt === 'number' ? state.typingAt : 0;
      out.push({
        clientId,
        user,
        typing: typingAt > 0 && nowMs - typingAt < TYPING_ACTIVE_MS,
      });
    }
    // Deterministic order (clientId asc) so the row doesn't jiggle as
    // the Map re-orders on each `change` event.
    return out.sort((a, b) => a.clientId - b.clientId);
  }, [states, localClientId, nowMs]);

  if (peers.length === 0) return null;

  return (
    <div className={`flex items-center -space-x-2 ${className ?? ''}`}>
      {peers.map((p) => (
        <CollabPresenceAvatar key={p.clientId} user={p.user} typing={p.typing} />
      ))}
    </div>
  );
}

interface CollabPresenceAvatarProps {
  user: NonNullable<AwarenessState['user']>;
  typing: boolean;
}

function CollabPresenceAvatar({ user, typing }: CollabPresenceAvatarProps) {
  // We always have *some* display name (the publisher in
  // `useCollabSession` falls back through name → username → userId), so
  // a missing-name branch is unreachable; we still treat the seed
  // defensively for older awareness payloads in flight.
  const seed = user.username ?? user.id ?? user.name;
  const userForAvatar = { username: seed, name: user.name };

  return (
    <div className="relative inline-flex" title={user.name} aria-label={typing ? `${user.name} (typing)` : user.name}>
      <span
        // Colored ring matches the caret yCollab paints in the editor,
        // so the viewer can correlate "the orange cursor over there =
        // the orange-ringed avatar up here". 2 px hairline keeps the
        // chrome subtle.
        className="ring-background inline-flex rounded-full ring-2"
        style={{ boxShadow: `0 0 0 2px ${user.color}` }}
      >
        <UserAvatar user={userForAvatar} size="sm" />
      </span>
      {typing && (
        <span aria-hidden="true" className="bg-background absolute -bottom-0.5 -right-0.5 flex h-3 items-center justify-center rounded-full px-0.5 shadow-sm">
          <TypingDots />
        </span>
      )}
    </div>
  );
}

/**
 * Three bouncing dots — pure CSS animation so we don't ship a JS timer
 * per avatar. Tailwind ships `animate-bounce` (~1 s cycle) and we
 * stagger each dot via inline `animationDelay` so the row flows left
 * to right instead of pulsing in unison.
 */
function TypingDots() {
  return (
    <span className="flex items-end gap-0.5">
      <span className="bg-muted-foreground inline-block size-1 animate-bounce rounded-full" style={{ animationDelay: '0ms' }} />
      <span className="bg-muted-foreground inline-block size-1 animate-bounce rounded-full" style={{ animationDelay: '150ms' }} />
      <span className="bg-muted-foreground inline-block size-1 animate-bounce rounded-full" style={{ animationDelay: '300ms' }} />
    </span>
  );
}
