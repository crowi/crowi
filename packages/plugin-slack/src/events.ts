import type { Context } from 'hono';
import type { PluginContext } from '@crowi/plugin-api';
import { verifySlackSignature } from './signature';
import { type ResolvedPage, type SlackUnfurls, buildUnfurlAttachment } from './unfurl';
import { postUnfurls } from './slack-client';
import { extractPagePaths, isPageIdPath, pageIdFromPath } from './link-parse';

/**
 * Plugin config shape the dispatcher reads at request time. `config()`
 * returns decrypted values (core handles `@sensitive` decryption), so the
 * dispatcher never touches crypto itself.
 */
export interface SlackPluginConfig {
  botToken: string;
  signingSecret: string;
}

/** A `link_shared` link entry as Slack sends it. */
interface SharedLink {
  url: string;
  domain?: string;
}

/**
 * Parsed Slack event envelope. Only the variants Phase 1 handles are
 * modelled; everything else is acknowledged with `200` so Slack does not
 * retry. The shape is intentionally loose (`unknown`-narrowing) because
 * the body is attacker-reachable until the signature check passes.
 */
type SlackEnvelope =
  | { type: 'url_verification'; challenge?: string }
  | { type: 'event_callback'; event?: { type?: string; channel?: string; message_ts?: string; links?: SharedLink[] } }
  | { type: string };

/**
 * Handle one inbound Slack request (mounted at `POST /events`,
 * `public: true`). This is the single internal dispatcher RFC-0013 §5
 * calls for — future `/slash` and `/interactions` routes will share it.
 *
 * Flow:
 *   1. Read the RAW body (`c.req.text()` — the route is validator-free, so
 *      this is the verbatim bytes the Slack HMAC was computed over).
 *   2. Verify the Slack signature (+ ±5-minute replay guard). Reject 401
 *      on failure — there is no Crowi session to fall back on.
 *   3. `url_verification` → echo the `challenge` (handshake).
 *   4. `event_callback` / `link_shared` → ACK `200` IMMEDIATELY, then do
 *      the `chat.unfurl` work asynchronously (idempotent under Slack's
 *      retries; we never await side effects inside the handler).
 */
export async function handleSlackEvent(c: Context, ctx: PluginContext, baseUrl: string | null): Promise<Response> {
  const rawBody = await c.req.text();
  const config = ctx.config<SlackPluginConfig>();

  const verification = verifySlackSignature({
    signingSecret: config.signingSecret,
    timestamp: c.req.header('x-slack-request-timestamp'),
    rawBody,
    signature: c.req.header('x-slack-signature'),
  });
  if (!verification.ok) {
    ctx.log.warn('rejected Slack request: %s', verification.reason);
    return c.json({ error: 'invalid_signature' }, 401);
  }

  const envelope = parseEnvelope(rawBody);
  if (!envelope) {
    return c.json({ error: 'bad_request' }, 400);
  }

  if (envelope.type === 'url_verification') {
    // Slack's one-time handshake: echo the challenge back verbatim.
    return c.json({ challenge: (envelope as { challenge?: string }).challenge ?? '' });
  }

  if (envelope.type === 'event_callback') {
    const event = (envelope as Extract<SlackEnvelope, { type: 'event_callback' }>).event;
    if (event?.type === 'link_shared' && event.channel && event.message_ts && Array.isArray(event.links)) {
      // Fire-and-forget: ACK now (Slack retries on slow / non-200), unfurl later.
      void unfurlSharedLinks({
        ctx,
        baseUrl,
        channel: event.channel,
        messageTs: event.message_ts,
        links: event.links,
      }).catch((err) => {
        ctx.log.error('chat.unfurl failed: %s', err instanceof Error ? err.message : String(err));
      });
    }
    return c.json({ ok: true });
  }

  // Unknown / unsupported event type — acknowledge so Slack stops retrying.
  return c.json({ ok: true });
}

/** Parse + minimally validate the JSON envelope, or null on malformed input. */
function parseEnvelope(rawBody: string): SlackEnvelope | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { type?: unknown }).type === 'string') {
      return parsed as SlackEnvelope;
    }
    return null;
  } catch {
    return null;
  }
}

interface UnfurlSharedLinksArgs {
  ctx: PluginContext;
  baseUrl: string | null;
  channel: string;
  messageTs: string;
  links: SharedLink[];
}

/**
 * Resolve each shared Crowi link to a Page, build a per-link unfurl
 * attachment, and post them in a single `chat.unfurl` call. Runs
 * asynchronously after the handler has already ACKed.
 */
async function unfurlSharedLinks(args: UnfurlSharedLinksArgs): Promise<void> {
  const { ctx, baseUrl, channel, messageTs, links } = args;
  if (!baseUrl) {
    ctx.log.warn('CLIENT_URL is unset; cannot resolve Slack-shared links to pages.');
    return;
  }

  const urlToPath = extractPagePaths(
    links.map((l) => l.url),
    baseUrl,
  );
  if (urlToPath.size === 0) {
    return;
  }

  const unfurls: SlackUnfurls = {};
  for (const [url, path] of urlToPath) {
    const page = await resolvePage(ctx, path);
    if (page) {
      unfurls[url] = buildUnfurlAttachment(url, page);
    }
  }

  if (Object.keys(unfurls).length === 0) {
    return;
  }

  await postUnfurls({ channel, ts: messageTs, unfurls });
}

/**
 * Mongoose document subset the unfurl flow reads off a Page. Loosely
 * typed because `ctx.model('Page')` is `unknown` at the plugin boundary;
 * we narrow at this single call site.
 */
interface PageLeanDoc {
  path: string;
  grant: number;
  updatedAt?: Date | string | null;
  revision?: { body?: string | null } | null;
}

interface PageModelLike {
  findOne(filter: Record<string, unknown>): {
    populate(path: string): { lean(): Promise<PageLeanDoc | null> };
  };
}

/**
 * Look up a page by path (or by `_id` for a bare-hex permalink) and shape
 * it into `ResolvedPage`. The revision is populated so the public-page
 * branch can build an excerpt. Returns null when the page does not exist.
 */
async function resolvePage(ctx: PluginContext, path: string): Promise<ResolvedPage | null> {
  const Page = ctx.model('Page') as PageModelLike;
  const filter = isPageIdPath(path) ? { _id: pageIdFromPath(path) } : { path };
  const doc = await Page.findOne(filter).populate('revision').lean();
  if (!doc) {
    return null;
  }
  const updatedAt = doc.updatedAt ? new Date(doc.updatedAt) : null;
  return {
    path: doc.path,
    grant: doc.grant,
    body: doc.revision?.body ?? null,
    updatedAtMs: updatedAt ? updatedAt.getTime() : null,
  };
}
