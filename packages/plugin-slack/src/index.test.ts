import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import type { PluginContext } from '@crowi/plugin-api';
import slackPlugin, { SlackConfigSchema } from './index';
import { verifySlackSignature } from './signature';
import { buildManifest, eventsRequestUrl, unfurlDomain } from './manifest';
import { EXCERPT_MAX_CHARS, buildUnfurlAttachment, type ResolvedPage } from './unfurl';
import { extractPagePaths, isPageIdPath, pageIdFromPath } from './link-parse';
import { handleSlackEvent, type SlackPluginConfig } from './events';

const SIGNING_SECRET = 'test-signing-secret';
const BASE_URL = 'https://wiki.example.com';

/** Sign a raw body the way Slack does, for the signature/dispatcher tests. */
function sign(rawBody: string, timestamp: number): string {
  const base = `v0:${timestamp}:${rawBody}`;
  return `v0=${createHmac('sha256', SIGNING_SECRET).update(base).digest('hex')}`;
}

/**
 * Minimal PluginContext stub. Only `config()` + `log` are consulted by
 * the dispatcher on the url_verification / signature-reject paths (the
 * link_shared path, which would call `model('Page')`, is fired async and
 * not awaited in these tests).
 */
function stubCtx(config: SlackPluginConfig): PluginContext {
  return {
    config: <T>() => config as T,
    dependencyConfig: <T>() => ({}) as T,
    appInfo: () => ({ title: 'Crowi', baseUrl: BASE_URL }),
    setConfig: async () => undefined,
    pageMetadata: {
      get: async () => null,
      set: async () => undefined,
      remove: async () => undefined,
    },
    model: () => ({}),
    // `state` (hot-reload StateCell primitive) is never consulted by the
    // dispatcher paths under test — a cast no-op stub keeps the mock minimal.
    state: (() => ({ get: () => undefined, withValue: async () => undefined, set: () => undefined })) as unknown as PluginContext['state'],
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  };
}

describe('@crowi/plugin-slack plugin contract', () => {
  it('exports a CrowiPlugin with the expected name + version + section', () => {
    expect(slackPlugin.name).toBe('@crowi/plugin-slack');
    expect(slackPlugin.version).toBe('0.1.0-dev');
    expect(slackPlugin.adminPlacement?.section).toBe('platform');
    expect(typeof slackPlugin.registerRoutes).toBe('function');
    expect(typeof slackPlugin.reconfigure).toBe('function');
  });

  it('declares @sensitive secrets and an @action manifest field', () => {
    const shape = SlackConfigSchema.shape;
    expect(shape.botToken.description).toContain('@sensitive');
    expect(shape.signingSecret.description).toContain('@sensitive');
    expect(shape.manifest.description).toContain('@action "Generate Slack App manifest" POST /manifest');
  });

  it('ships localized manifest help linking to the Slack app creation page', () => {
    expect(slackPlugin.configI18n?.ja?.manifest?.description).toContain('https://api.slack.com/apps/');
    expect(slackPlugin.configI18n?.en?.manifest?.description).toContain('https://api.slack.com/apps/');
  });

  // feature-plugin-capability-scoping: declares exactly the models it
  // reads (read-only) via ctx.model('Page') in events.ts.
  it('declares modelAccess for the models it reads via ctx.model()', () => {
    expect(slackPlugin.modelAccess).toEqual(['Page']);
  });
});

describe('verifySlackSignature', () => {
  const rawBody = JSON.stringify({ type: 'event_callback' });
  const now = 1_700_000_000;

  it('accepts a valid signature within the replay window', () => {
    const result = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      timestamp: String(now),
      rawBody,
      signature: sign(rawBody, now),
      nowSeconds: now,
    });
    expect(result).toEqual({ ok: true });
  });

  it('rejects an expired timestamp (older than ±5 minutes)', () => {
    const oldTs = now - 6 * 60;
    const result = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      timestamp: String(oldTs),
      rawBody,
      signature: sign(rawBody, oldTs),
      nowSeconds: now,
    });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a tampered body (signature mismatch)', () => {
    const result = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      timestamp: String(now),
      rawBody: `${rawBody}tampered`,
      signature: sign(rawBody, now),
      nowSeconds: now,
    });
    expect(result).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a wrong signing secret', () => {
    const result = verifySlackSignature({
      signingSecret: 'wrong-secret',
      timestamp: String(now),
      rawBody,
      signature: sign(rawBody, now),
      nowSeconds: now,
    });
    expect(result).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects missing headers', () => {
    const result = verifySlackSignature({ signingSecret: SIGNING_SECRET, timestamp: undefined, rawBody, signature: undefined, nowSeconds: now });
    expect(result).toEqual({ ok: false, reason: 'missing-headers' });
  });

  it('rejects when no signing secret is configured', () => {
    const result = verifySlackSignature({ signingSecret: '', timestamp: String(now), rawBody, signature: sign(rawBody, now), nowSeconds: now });
    expect(result).toEqual({ ok: false, reason: 'unconfigured' });
  });
});

describe('buildManifest', () => {
  const manifest = buildManifest({ baseUrl: BASE_URL, wikiName: 'Acme Wiki' });

  it('names the app after the wiki and describes the integration broadly', () => {
    expect(manifest.display_information.name).toBe('Acme Wiki');
    expect(manifest.display_information.description).toContain('Acme Wiki');
    // Description is forward-looking (not unfurl-only) for later capabilities.
    expect(manifest.display_information.description).toMatch(/notifications|slash commands/);
  });

  it("truncates an over-long wiki name to Slack's 35-char name limit", () => {
    const m = buildManifest({ baseUrl: BASE_URL, wikiName: 'A'.repeat(50) });
    expect(m.display_information.name).toBe('A'.repeat(35));
    expect(m.display_information.name.length).toBeLessThanOrEqual(35);
    expect(m.display_information.description.length).toBeLessThanOrEqual(140);
  });

  it('points request_url at the namespaced /events route', () => {
    expect(manifest.settings.event_subscriptions.request_url).toBe('https://wiki.example.com/api/plugins/@crowi/plugin-slack/events');
    expect(eventsRequestUrl(BASE_URL)).toBe(manifest.settings.event_subscriptions.request_url);
  });

  it('subscribes to link_shared and registers the wiki host as an unfurl domain under features', () => {
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(['link_shared']);
    // unfurl_domains lives under `features`, not `settings` (Slack rejects
    // it under settings as "Invalid additional property").
    expect(manifest.features.unfurl_domains).toEqual(['wiki.example.com']);
    expect((manifest.settings as Record<string, unknown>).unfurl_domains).toBeUndefined();
    expect(unfurlDomain(BASE_URL)).toBe('wiki.example.com');
  });

  it('declares a bot user (required for bot events + chat.unfurl)', () => {
    expect(manifest.features.bot_user.display_name).toBe('Acme Wiki');
    expect(manifest.features.bot_user.always_online).toBe(false);
  });

  it('requests least-privilege bot scopes only', () => {
    expect(manifest.oauth_config.scopes.bot).toEqual(['links:read', 'links:write', 'chat:write']);
  });

  it('disables socket mode (HTTP Events API is used)', () => {
    expect(manifest.settings.socket_mode_enabled).toBe(false);
  });

  it('strips a trailing slash on the base URL', () => {
    expect(eventsRequestUrl('https://wiki.example.com/')).toBe('https://wiki.example.com/api/plugins/@crowi/plugin-slack/events');
  });
});

describe('buildUnfurlAttachment — public vs restricted branch', () => {
  const url = 'https://wiki.example.com/team/handbook/onboarding';

  it('builds a rich card for a public (GRANT_PUBLIC) page', () => {
    const page: ResolvedPage = {
      path: '/team/handbook/onboarding',
      grant: 1,
      body: 'Welcome to the team. This page covers onboarding.',
      updatedAtMs: 1_700_000_000_000,
    };
    const att = buildUnfurlAttachment(url, page);
    expect(att.title).toBe('onboarding');
    expect(att.title_link).toBe(url);
    expect(att.footer).toBe('/team/handbook/onboarding');
    expect(att.text).toContain('Welcome to the team');
    expect(att.ts).toBe('1700000000');
  });

  it('truncates a long body to an excerpt with an ellipsis', () => {
    const page: ResolvedPage = { path: '/long', grant: 1, body: 'x'.repeat(EXCERPT_MAX_CHARS + 500), updatedAtMs: null };
    const att = buildUnfurlAttachment(url, page);
    expect(att.text?.endsWith('…')).toBe(true);
    expect((att.text ?? '').length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS + 1);
  });

  it('drops a half-formed <url|text> token when truncation lands inside it', () => {
    // Body fills to just before the cut, then a link whose converted
    // <https://…|docs> token straddles EXCERPT_MAX_CHARS so truncation
    // lands inside the token.
    const body = `${'a'.repeat(EXCERPT_MAX_CHARS - 15)} [docs](https://example.com/very/long/path/here)`;
    const att = buildUnfurlAttachment(url, { path: '/long', grant: 1, body, updatedAtMs: null });
    expect(att.text?.endsWith('…')).toBe(true);
    // No dangling, never-closed `<` left at the tail of the excerpt.
    expect(att.text).not.toMatch(/<[^>]*$/);
  });

  it('routes the excerpt through markdownToMrkdwn with baseUrl (relative links resolved)', () => {
    const page: ResolvedPage = {
      path: '/team/handbook/onboarding',
      grant: 1,
      body: '# Onboarding\n\nSee the [handbook](/team/handbook).',
      updatedAtMs: null,
    };
    const att = buildUnfurlAttachment(url, page, 'https://wiki.example.com');
    // The relative link resolving to an absolute Slack link proves the
    // excerpt was both converted AND given the baseUrl; the conversion
    // rules themselves are owned by mrkdwn.test.ts.
    expect(att.text).toContain('<https://wiki.example.com/team/handbook|handbook>');
  });

  it('omits the text field when the body converts to only whitespace', () => {
    const att = buildUnfurlAttachment(url, { path: '/blank', grant: 1, body: '   \n\n   ', updatedAtMs: null });
    expect(att.text).toBeUndefined();
  });

  it('emits a minimal 🔒 restricted card for a non-public page (no body)', () => {
    const page: ResolvedPage = { path: '/secret/notes', grant: 2, body: 'top secret contents', updatedAtMs: 1_700_000_000_000 };
    const att = buildUnfurlAttachment(url, page);
    expect(att.title).toContain('Restricted');
    expect(att.text).not.toContain('top secret contents');
    expect(att.ts).toBeUndefined();
    // No footer/path: an opaque /<id> permalink hides the path, so the card
    // must not reveal it anywhere (RFC-0013 §8 data-leakage guard).
    expect(att.footer).toBeUndefined();
    expect(JSON.stringify(att)).not.toContain('/secret/notes');
  });

  it('treats GRANT_OWNER / GRANT_SPECIFIED as non-public too', () => {
    for (const grant of [3, 4]) {
      const att = buildUnfurlAttachment(url, { path: '/p', grant, body: 'private', updatedAtMs: null });
      expect(att.title).toContain('Restricted');
    }
  });
});

describe('extractPagePaths', () => {
  it('keeps only links to the wiki host and returns the page path', () => {
    const urls = ['https://wiki.example.com/team/handbook', 'https://evil.example.com/team/handbook', 'https://wiki.example.com/'];
    const out = extractPagePaths(urls, BASE_URL);
    expect(out.get('https://wiki.example.com/team/handbook')).toBe('/team/handbook');
    expect(out.has('https://evil.example.com/team/handbook')).toBe(false);
    // The root portal is not an unfurlable page.
    expect(out.has('https://wiki.example.com/')).toBe(false);
  });

  it('decodes percent-encoded paths and drops query/fragment', () => {
    const url = 'https://wiki.example.com/%E3%83%81%E3%83%BC%E3%83%A0/notes?compare=1#x';
    const out = extractPagePaths([url], BASE_URL);
    expect(out.get(url)).toBe('/チーム/notes');
  });

  it('detects a bare ObjectId permalink', () => {
    expect(isPageIdPath('/5e1b2c3d4f5a6b7c8d9e0f12')).toBe(true);
    expect(isPageIdPath('/team/handbook')).toBe(false);
    expect(pageIdFromPath('/5e1b2c3d4f5a6b7c8d9e0f12')).toBe('5e1b2c3d4f5a6b7c8d9e0f12');
  });
});

describe('handleSlackEvent — dispatcher', () => {
  const now = Math.floor(Date.now() / 1000);

  async function postEvent(body: string, headers: Record<string, string>): Promise<Response> {
    const app = new Hono();
    const ctx = stubCtx({ botToken: '', signingSecret: SIGNING_SECRET });
    app.post('/events', (c) => handleSlackEvent(c, ctx, BASE_URL));
    return app.request('/events', { method: 'POST', headers, body });
  }

  it('echoes the url_verification challenge after a valid signature', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const res = await postEvent(body, {
      'x-slack-request-timestamp': String(now),
      'x-slack-signature': sign(body, now),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ challenge: 'abc123' });
  });

  it('rejects an invalid signature with 401', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const res = await postEvent(body, {
      'x-slack-request-timestamp': String(now),
      'x-slack-signature': 'v0=deadbeef',
    });
    expect(res.status).toBe(401);
  });

  it('rejects an expired timestamp with 401 (replay guard)', async () => {
    const oldTs = now - 6 * 60;
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const res = await postEvent(body, {
      'x-slack-request-timestamp': String(oldTs),
      'x-slack-signature': sign(body, oldTs),
    });
    expect(res.status).toBe(401);
  });

  it('ACKs an event_callback immediately (200) without awaiting side effects', async () => {
    const body = JSON.stringify({ type: 'event_callback', event: { type: 'app_mention' } });
    const res = await postEvent(body, {
      'x-slack-request-timestamp': String(now),
      'x-slack-signature': sign(body, now),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});
