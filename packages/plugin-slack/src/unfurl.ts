import { GRANT_PUBLIC } from './constants-grant';
import { markdownToMrkdwn } from './mrkdwn';

/**
 * A single Slack `attachment` (legacy unfurl block) keyed by the link URL
 * in the `chat.unfurl` `unfurls` map. We deliberately use the legacy
 * `attachments`-style shape (`title` / `title_link` / `text`) the old
 * Crowi integration used (`util/slack.ts.reference`) — it renders a clean
 * card without needing Block Kit.
 */
export interface SlackUnfurlAttachment {
  title: string;
  title_link: string;
  text?: string;
  footer?: string;
  /** Unix seconds as a string — Slack's `MessageAttachment.ts` is string-typed. */
  ts?: string;
  mrkdwn_in?: ('text' | 'pretext' | 'fields')[];
}

/** The `unfurls` argument to `chat.unfurl`: `{ [url]: attachment }`. */
export type SlackUnfurls = Record<string, SlackUnfurlAttachment>;

/**
 * The minimal resolved-page shape the unfurl builder needs. Filled by
 * `events.ts` from a `ctx.model('Page')` lookup (+ populated revision);
 * keeping the builder a pure function over this shape lets us unit-test
 * the public-vs-restricted branch without Mongo.
 */
export interface ResolvedPage {
  path: string;
  grant: number;
  /** Revision body markdown (public pages only need it). */
  body: string | null;
  /** Page `updatedAt` epoch millis, or null when unknown. */
  updatedAtMs: number | null;
}

/**
 * Max characters of body to surface as the unfurl excerpt. Slack collapses
 * long attachment text behind a "Show more" toggle and expands it in place
 * on click, so this is the *expanded* length — keep it generous enough that
 * "Show more" reveals a useful amount, not the few lines shown collapsed.
 */
export const EXCERPT_MAX_CHARS = 1000;

/**
 * Upper bound on how much raw body we feed the markdown converter. The
 * excerpt only needs the head, and converting a whole large page would be
 * wasted work (the result is truncated to `EXCERPT_MAX_CHARS` anyway).
 */
const SOURCE_SCAN_CHARS = EXCERPT_MAX_CHARS * 4;

/**
 * Build the `chat.unfurl` attachment for one shared Crowi link.
 *
 * **Data-leakage guard (RFC-0013 §7.1 / §8)**: a Slack unfurl is visible
 * to everyone in the channel, with no Crowi auth in the loop. So only
 * `GRANT_PUBLIC` pages get the rich card (title + excerpt + breadcrumb +
 * updated-at). Any non-public page (restricted / specified / owner) gets
 * a minimal "🔒 restricted" card with NO body — grant-aware full unfurl
 * needs a Slack-user ↔ Crowi-user mapping (Phase 2 account linking) and
 * is intentionally out of scope for v1.
 *
 * The card text is English-only on purpose: it renders inside Slack, not
 * the Crowi UI, and Slack workspaces have no Crowi locale to key off.
 *
 * `baseUrl` (the wiki's public origin) is used only to resolve
 * site-relative markdown links in the excerpt to absolute Slack links;
 * pass `null` when it is unavailable (such links then render as plain
 * text).
 */
export function buildUnfurlAttachment(url: string, page: ResolvedPage, baseUrl: string | null = null): SlackUnfurlAttachment {
  const breadcrumb = pageBreadcrumb(page.path);

  if (page.grant !== GRANT_PUBLIC) {
    return {
      title: '🔒 Restricted page',
      title_link: url,
      text: 'This Crowi page is not public, so its contents are not shown here.',
      footer: breadcrumb,
    };
  }

  const attachment: SlackUnfurlAttachment = {
    title: pageTitle(page.path),
    title_link: url,
    footer: breadcrumb,
    mrkdwn_in: ['text'],
  };

  const excerpt = buildExcerpt(page.body, baseUrl);
  if (excerpt) {
    attachment.text = excerpt;
  }
  if (page.updatedAtMs != null) {
    // Slack renders `ts` as a localized "updated at" timestamp in the footer.
    attachment.ts = String(Math.floor(page.updatedAtMs / 1000));
  }

  return attachment;
}

/**
 * The last path segment is the page's display title (e.g.
 * `/team/handbook/onboarding` → `onboarding`). Falls back to the full
 * path for top-level pages.
 */
function pageTitle(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  const tail = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  return tail || path;
}

/** The full path, shown as a breadcrumb-style footer. */
function pageBreadcrumb(path: string): string {
  return path;
}

/**
 * Build the excerpt: convert the head of the body from Markdown to Slack
 * mrkdwn (so headings / lists / links read cleanly rather than as raw
 * source — see `mrkdwn.ts`), then trim to `EXCERPT_MAX_CHARS` with an
 * ellipsis. Returns null for an empty / whitespace-only body so the
 * attachment simply omits the `text` field.
 */
function buildExcerpt(body: string | null, baseUrl: string | null): string | null {
  if (!body) return null;
  const head = body.length > SOURCE_SCAN_CHARS ? body.slice(0, SOURCE_SCAN_CHARS) : body;
  const normalized = markdownToMrkdwn(head, { baseUrl }).trim();
  if (!normalized) return null;
  if (normalized.length <= EXCERPT_MAX_CHARS) {
    return normalized;
  }
  return truncateExcerpt(normalized, EXCERPT_MAX_CHARS);
}

/**
 * Hard-cap the excerpt at `max` chars + ellipsis. If the cut landed inside
 * a Slack link token (`<url|text`), drop that half-formed token so the
 * card never renders a dangling `<…`.
 */
function truncateExcerpt(text: string, max: number): string {
  let cut = text.slice(0, max);
  const lastOpen = cut.lastIndexOf('<');
  const lastClose = cut.lastIndexOf('>');
  if (lastOpen > lastClose) {
    cut = cut.slice(0, lastOpen);
  }
  return `${cut.trimEnd()}…`;
}
