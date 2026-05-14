import Debug from 'debug';
import { v4 as uuidv4 } from 'uuid';
import { createClient, type RedisClientType } from 'redis';
import { resolveApiDistFile } from './api-dist';

const debug = Debug('crowi:collab:page-event-pubsub');

/**
 * RFC-0003 Phase 5 — collab-side Redis publisher for the pageEvent
 * fan-out. The api process owns the subscriber half (`packages/api/
 * src/service/page-event-pubsub.ts`) and re-emits onto its local
 * EventEmitter so backlink / search / mention-dispatch listeners
 * react to collab-initiated saves.
 *
 * Why a thin publisher-only client (not the full pubsub class)? The
 * collab process never *subscribes* — it only fires events outward
 * after a save. Keeping the surface narrow:
 *   - Avoids requiring the api dist surface for the subscriber wiring
 *     (which depends on `crowi.event('Page')` and `crowi.model(...)`).
 *   - Keeps the collab boot snappy: one Redis connection instead of
 *     two.
 *
 * Wire compatibility: channel naming + payload shape must match the
 * api side exactly. The shared keys are listed below as constants so
 * a drift on either side is one-grep-away from being spotted.
 */

const CHANNEL_PREFIX = 'crowi:pageEvent:';

export type PageEventName = 'create' | 'update' | 'delete';

const channelFor = (name: PageEventName): string => `${CHANNEL_PREFIX}${name}`;

export interface PageEventPayload {
  instanceId: string;
  eventName: PageEventName;
  pageId: string;
  userId: string;
  bookmarkCount?: number;
}

export interface CollabPageEventPublisher {
  /** Process-local UUID — every published payload carries this to break self-publish loops. */
  readonly instanceId: string;
  /** Best-effort fire-and-forget. Never throws; failures warn. */
  publish(eventName: PageEventName, payload: Omit<PageEventPayload, 'instanceId' | 'eventName'>): Promise<void>;
  disconnect(): Promise<void>;
}

export interface CreateCollabPageEventPublisherOptions {
  /** `REDIS_URL` (or REDIS_TLS_URL / REDISTOGO_URL legacy alias). When null/undefined we return a no-op publisher. */
  redisUrl?: string | null;
  /**
   * Reject self-signed certificates on rediss:// connections. Defaults
   * to true; set to false (via `REDIS_REJECT_UNAUTHORIZED=0`) for
   * dev / staging environments running on self-signed Redis hosts.
   */
  redisRejectUnauthorized?: boolean;
}

// `buildRedisOpts` lives in `@crowi/api/dist/util/redis-opts.js` so
// api and collab negotiate the same TLS / port / password semantics
// against the same Redis instance. Pulled via the established
// `api-dist.ts` resolver (used by ws-token / collab-cap / models).
interface ApiRedisOptsModule {
  buildRedisOpts(redisUrl: string | null, rejectUnauthorized: boolean): Record<string, unknown> | null;
}

const makeNoopPublisher = (instanceId: string): CollabPageEventPublisher => ({
  instanceId,
  async publish(eventName, payload) {
    debug('publish(%s, %s): redis not configured — skipping', eventName, payload.pageId);
  },
  async disconnect() {
    /* nothing to disconnect */
  },
});

/**
 * Construct (and connect) a Redis publisher for the pageEvent
 * channel. Failure modes:
 *
 *   - No `redisUrl` → returns a no-op publisher (collab still runs;
 *     save flow still completes; api process won't observe remote
 *     events).
 *   - Connect failure → warn + return no-op publisher. The collab
 *     process must not die because Redis is briefly unavailable —
 *     save throughput stays unblocked, and the next compaction /
 *     write path eventually re-converges.
 *
 * Callers (notably `index.ts` / `server.ts`) keep a reference and
 * call `.disconnect()` from the shutdown handler so the parent
 * Hocuspocus process exits cleanly.
 */
export async function createCollabPageEventPublisher(opts: CreateCollabPageEventPublisherOptions): Promise<CollabPageEventPublisher> {
  const instanceId = uuidv4();
  if (!opts.redisUrl) {
    console.warn('[crowi:collab] REDIS_URL not configured — page-event publish to api is disabled (single-instance mode).');
    return makeNoopPublisher(instanceId);
  }

  const rejectUnauthorized = opts.redisRejectUnauthorized ?? true;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const apiRedisOpts = require(resolveApiDistFile('util/redis-opts.js')) as ApiRedisOptsModule;
  const redisOpts = apiRedisOpts.buildRedisOpts(opts.redisUrl, rejectUnauthorized);

  let client: RedisClientType;
  try {
    client = createClient(redisOpts ?? undefined);
    await client.connect();
  } catch (err) {
    console.warn('[crowi:collab] Redis publisher connect failed — page-event fan-out disabled.', (err as Error).message);
    return makeNoopPublisher(instanceId);
  }

  debug('redis publisher connected (instanceId=%s)', instanceId);

  return {
    instanceId,
    async publish(eventName, payload) {
      const full: PageEventPayload = { ...payload, instanceId, eventName };
      try {
        await client.publish(channelFor(eventName), JSON.stringify(full));
        debug('published %s for page %s', eventName, payload.pageId);
      } catch (err) {
        console.warn(`[crowi:collab] page-event publish failed (event=${eventName}, page=${payload.pageId}):`, (err as Error).message);
      }
    },
    async disconnect() {
      try {
        await client.disconnect();
      } catch (err) {
        debug('disconnect error: %s', (err as Error).message);
      }
    },
  };
}
