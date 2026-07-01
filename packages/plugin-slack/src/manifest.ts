import { PLUGIN_NAME } from './constants';

/**
 * The Slack App manifest the admin pastes into Slack's "create app from
 * manifest" flow. We embed the instance's own inbound URL + the wiki
 * host so the operator never hand-types them.
 *
 * Only the fields Slack requires for the Phase 1 unfurl surface are
 * emitted; OAuth scopes are least-privilege (RFC-0013 §6):
 *   - `links:read`  — receive `link_shared` events for our domain
 *   - `links:write` — call `chat.unfurl`
 *   - `chat:write`  — required companion of `chat:write`-family calls;
 *                     also forward-compatible with Phase 3 notifications
 */
export interface SlackManifest {
  display_information: { name: string; description: string };
  features: {
    /** A bot user is required to receive bot events + call `chat.unfurl`. */
    bot_user: { display_name: string; always_online: boolean };
    /**
     * Domains Slack sends `link_shared` for. Lives under `features` (NOT
     * `settings` — Slack rejects it there: "Invalid additional property").
     */
    unfurl_domains?: string[];
  };
  oauth_config: { scopes: { bot: string[] } };
  settings: {
    event_subscriptions: {
      request_url: string;
      bot_events: string[];
    };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
  };
}

export interface BuildManifestInput {
  /**
   * Public origin Slack will reach the inbound endpoint at. In production
   * this is `CLIENT_URL` (= `crowi.getBaseUrl()`); in dev it is the tunnel
   * override (`SLACK_MANIFEST_REQUEST_URL`) since Slack cannot reach
   * `localhost`. Must be an absolute `https://…` origin.
   */
  baseUrl: string;
  /**
   * The wiki's display name (core `app:title`, via `ctx.appInfo()`), used
   * as the Slack App name. Always a non-empty string — the `'Crowi'`
   * default is supplied by `appInfo()`, not here.
   */
  wikiName: string;
}

/** Slack caps `display_information.name` at 35 chars, `description` at 140. */
const MAX_NAME_LEN = 35;
const MAX_DESCRIPTION_LEN = 140;

/** The bot events we subscribe to (Phase 1: link unfurling only). */
const SUBSCRIBED_BOT_EVENTS = ['link_shared'];

/** Least-privilege bot scopes for the unfurl surface. */
const BOT_SCOPES = ['links:read', 'links:write', 'chat:write'];

/**
 * The path the Events API webhook is mounted at (Phase 0 `registerRoutes`
 * + `public: true`). Kept here so the manifest's `request_url` and the
 * route registration in `index.ts` cannot drift.
 */
export const EVENTS_ROUTE_PATH = '/events';

/** Full inbound URL Slack posts events to: `<base>/api/v2/plugins/<name>/events`. */
export function eventsRequestUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/api/v2/plugins/${PLUGIN_NAME}${EVENTS_ROUTE_PATH}`;
}

/**
 * Derive the bare host (no scheme, no trailing slash) used as the Slack
 * `unfurl_domains` entry — Slack only sends `link_shared` for links whose
 * host matches one of these. Returns null when the URL can't be parsed so
 * the manifest simply omits the (optional) domains array rather than
 * embedding garbage.
 */
export function unfurlDomain(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

export function buildManifest(input: BuildManifestInput): SlackManifest {
  const host = unfurlDomain(input.baseUrl);
  const name = input.wikiName.slice(0, MAX_NAME_LEN);
  // Describe the integration broadly (not just unfurl) so the manifest
  // stays accurate as later capabilities — notifications, slash commands —
  // ship under the same Slack App.
  const description = `Slack integration for ${name}: wiki page link unfurls, with notifications and slash commands to come.`.slice(0, MAX_DESCRIPTION_LEN);
  return {
    display_information: {
      name,
      description,
    },
    features: {
      bot_user: { display_name: name, always_online: false },
      ...(host ? { unfurl_domains: [host] } : {}),
    },
    oauth_config: {
      scopes: { bot: BOT_SCOPES },
    },
    settings: {
      event_subscriptions: {
        request_url: eventsRequestUrl(input.baseUrl),
        bot_events: SUBSCRIBED_BOT_EVENTS,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
    },
  };
}
