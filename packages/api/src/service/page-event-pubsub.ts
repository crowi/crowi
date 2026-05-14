import Debug from 'debug';
import { v4 as uuidv4 } from 'uuid';
import { createClient, type RedisClientType } from 'redis';
import type Crowi from 'src/crowi';

const debug = Debug('crowi:service:page-event-pubsub');

/**
 * RFC-0003 Phase 5 — cross-process fan-out of `pageEvent('create' |
 * 'update' | 'delete')` via Redis pub/sub.
 *
 * Motivation: the @crowi/collab process (Hocuspocus host) creates new
 * Revisions when a client triggers `crowi:save`, but the api process
 * is the only place that owns the renderer / backlink / search-index /
 * mention-dispatch listeners (`packages/api/src/events/*`). Without
 * pub/sub, a save-on-collab would leave those subscribers cold and
 * indexes / cached embeds would drift.
 *
 * Wire-level design:
 *   - One channel per event name: `crowi:pageEvent:<eventName>` so a
 *     listener loop in api doesn't have to switch on a discriminator
 *     inside the payload.
 *   - Payload is **opaque-id-only** by intent: `{ instanceId, pageId,
 *     userId, bookmarkCount? }`. We avoid serialising full
 *     Page / User docs because (a) BSON ↔ JSON round-trips shrink some
 *     types (Buffer, ObjectId) in subtle ways, (b) subscribers usually
 *     want fresh-from-Mongo data anyway — `events/render-cache.ts`
 *     reads `_id`, `events/mention-dispatch.ts` re-fetches by
 *     `revision`. The subscriber here re-hydrates with one
 *     `Page.findById` + one `User.findById` before re-emitting locally.
 *   - `instanceId` (uuid v4, generated once per api process at boot)
 *     guards against the self-publish loop: a publish from this
 *     process is observed by its own subscriber and skipped.
 *
 * Failure model: every Redis interaction is best-effort.
 *   - No Redis configured → `setupPageEventPubSub` is a no-op +
 *     warning; `publishPageEvent` is a no-op.
 *   - Subscribe error → warn + degrade to no-op publisher; api
 *     subscribers will eventually re-fire on the next api-side write
 *     (legacy `Page.updatePage` callsites still emit locally).
 *   - Publish error → warn but never throw — the save flow on the
 *     collab side has already committed.
 *
 * Channel naming is intentionally aligned with `service/config.ts`'s
 * `crowi:config:*` prefix so a wildcard subscribe (`crowi:*`) covers
 * cluster-wide fan-out if we ever need it.
 */

/**
 * The event names broadcast over pub/sub. Phase 5 only **wires** the
 * `update` channel (collab save → api fan-out), but the publisher
 * interface accepts `create` / `delete` so future phases (Phase 6
 * force-reload, follow-up RFCs for cross-instance delete) can light
 * them up without changing the wire format.
 */
export type PageEventName = 'create' | 'update' | 'delete';

const CHANNEL_PREFIX = 'crowi:pageEvent:';
const ALL_EVENT_NAMES: readonly PageEventName[] = ['create', 'update', 'delete'] as const;

const channelFor = (name: PageEventName): string => `${CHANNEL_PREFIX}${name}`;

/**
 * Wire format of every published message. Kept minimal so subscribers
 * are forced to re-fetch fresh state from Mongo — this avoids stale
 * snapshots when the publisher and subscriber race.
 */
export interface PageEventPayload {
  instanceId: string;
  eventName: PageEventName;
  pageId: string;
  userId: string;
  bookmarkCount?: number;
}

/**
 * Public surface of the pub/sub service. The api side reaches for
 * `publishPageEvent` when **api-side** mutations should also reach
 * sibling instances (Phase 9 multi-server scenario); the collab
 * process talks to its own light-weight publisher in
 * `packages/collab/src/page-event-pubsub.ts` so its dep surface stays
 * narrow.
 */
export interface PageEventPubSub {
  /** Process-local UUID — published payloads carry this so we filter our own messages. */
  readonly instanceId: string;
  /** True once `setup()` succeeded (or determined Redis isn't configured). */
  readonly isReady: boolean;
  setup(): Promise<void>;
  publishPageEvent(eventName: PageEventName, payload: Omit<PageEventPayload, 'instanceId' | 'eventName'>): Promise<void>;
  /** Test / shutdown helper — disconnect both clients. */
  shutdown(): Promise<void>;
}

/**
 * Build a Crowi-bound pub/sub instance. Wires the subscriber to
 * `crowi.event('Page')` for cross-process re-emit and exposes
 * `publishPageEvent` for forward fan-out. The handle is also stored on
 * `crowi.pageEventPubSub` (set by `Crowi.setupPageEventPubSub()`) so
 * legacy callsites can call `crowi.pageEventPubSub.publishPageEvent`
 * after a `pageEvent.emit('update', ...)` if they want cluster fan-out.
 */
export function createPageEventPubSub(crowi: Crowi): PageEventPubSub {
  const instanceId = uuidv4();
  let publisher: RedisClientType | null = null;
  let subscriber: RedisClientType | null = null;
  let ready = false;

  async function rehydrateAndEmit(payload: PageEventPayload): Promise<void> {
    if (payload.instanceId === instanceId) {
      debug('skipping self-published event (instanceId=%s)', instanceId);
      return;
    }

    const Page = crowi.model('Page');
    const User = crowi.model('User');

    // Hydrate Page + User in parallel. Page being missing is the only
    // hard fail (no payload to emit); a missing user is downgraded to
    // a warn-and-continue so listeners that don't read `user` still
    // benefit from the page-level fan-out.
    const [pageResult, userResult] = await Promise.allSettled([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Page as any).findById(payload.pageId).exec(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (User as any).findById(payload.userId).exec(),
    ]);

    if (pageResult.status === 'rejected') {
      console.warn(`[crowi:page-event-pubsub] Page.findById(${payload.pageId}) failed:`, (pageResult.reason as Error).message);
      return;
    }
    const pageDoc = pageResult.value;
    if (!pageDoc) {
      debug('hydrate: page %s not found, skipping fan-out', payload.pageId);
      return;
    }

    let userDoc: unknown;
    if (userResult.status === 'rejected') {
      console.warn(`[crowi:page-event-pubsub] User.findById(${payload.userId}) failed:`, (userResult.reason as Error).message);
    } else {
      userDoc = userResult.value;
    }

    const pageEvent = crowi.event('Page');
    // Match the wire shape used by `Page.updatePage` / `Page.createPage`
    // so api-side listeners (events/page.ts, events/render-cache.ts,
    // events/mention-dispatch.ts) don't need pub/sub-specific branches.
    pageEvent.emit(payload.eventName, pageDoc, userDoc, payload.bookmarkCount ?? 0);
  }

  async function setup(): Promise<void> {
    const { redisOpts } = crowi;
    if (!redisOpts) {
      console.warn('[crowi:page-event-pubsub] REDIS_URL not configured — cross-process pageEvent fan-out is disabled (single-instance mode).');
      ready = true; // "configured to be off" — publishPageEvent stays a no-op
      return;
    }

    try {
      publisher = createClient(redisOpts);
      subscriber = createClient(redisOpts);
      await publisher.connect();
      await subscriber.connect();

      // Mirror `service/config.ts:setupPubSub` — v4 redis takes the
      // listener as the 2nd arg to `.subscribe`. The v3 `.on('message')`
      // pattern silently no-ops on v4 and the process never sees a
      // single message.
      for (const eventName of ALL_EVENT_NAMES) {
        const channel = channelFor(eventName);
        // eslint-disable-next-line no-await-in-loop
        await subscriber.subscribe(channel, async (message, incomingChannel) => {
          if (incomingChannel !== channel) return;
          let parsed: PageEventPayload;
          try {
            parsed = JSON.parse(message) as PageEventPayload;
          } catch (err) {
            console.warn(`[crowi:page-event-pubsub] dropping malformed message on ${channel}:`, (err as Error).message);
            return;
          }
          if (parsed.eventName !== eventName) {
            // Defensive: the channel-name and payload disagree. This
            // only happens if a remote runs an older publisher that
            // doesn't set `eventName`; degrade to "trust the channel".
            parsed = { ...parsed, eventName };
          }
          try {
            await rehydrateAndEmit(parsed);
          } catch (err) {
            console.warn(`[crowi:page-event-pubsub] rehydrate failed for ${parsed.pageId}:`, (err as Error).message);
          }
        });
      }
      ready = true;
      debug('page event pub/sub ready (instanceId=%s, channels=%o)', instanceId, ALL_EVENT_NAMES.map(channelFor));
    } catch (err) {
      console.warn('[crowi:page-event-pubsub] Redis setup failed; cross-process pageEvent fan-out disabled.', (err as Error).message);
      // Degrade gracefully — publish() will be a no-op + warn.
      publisher = null;
      subscriber = null;
      ready = true;
    }
  }

  async function publishPageEvent(eventName: PageEventName, payload: Omit<PageEventPayload, 'instanceId' | 'eventName'>): Promise<void> {
    if (!publisher) {
      debug('publishPageEvent(%s, %s): no publisher (Redis disabled / failed) — skipping', eventName, payload.pageId);
      return;
    }
    const full: PageEventPayload = { ...payload, instanceId, eventName };
    try {
      await publisher.publish(channelFor(eventName), JSON.stringify(full));
    } catch (err) {
      console.warn(`[crowi:page-event-pubsub] publish failed (event=${eventName}, page=${payload.pageId}):`, (err as Error).message);
    }
  }

  async function shutdown(): Promise<void> {
    const targets: Array<Promise<unknown>> = [];
    if (subscriber) {
      targets.push(subscriber.disconnect().catch((err: unknown) => debug('subscriber disconnect: %s', (err as Error).message)));
      subscriber = null;
    }
    if (publisher) {
      targets.push(publisher.disconnect().catch((err: unknown) => debug('publisher disconnect: %s', (err as Error).message)));
      publisher = null;
    }
    await Promise.all(targets);
    ready = false;
  }

  return {
    get instanceId() {
      return instanceId;
    },
    get isReady() {
      return ready;
    },
    setup,
    publishPageEvent,
    shutdown,
  };
}
