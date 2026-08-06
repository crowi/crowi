import { z } from 'zod/v3';
import type { CrowiPlugin, PluginContext } from '@crowi/plugin-api';
import { PLUGIN_NAME } from './constants';
import { EVENTS_ROUTE_PATH, buildManifest } from './manifest';
import { handleSlackEvent, type SlackPluginConfig } from './events';
import { configureSlackClient } from './slack-client';

/**
 * Global config for the Slack integration. Both secrets are `@sensitive`
 * (encrypted at rest by core); `config()` hands the plugin the decrypted
 * values, so the plugin never touches crypto itself.
 */
const SlackConfigSchema = z
  .object({
    /** Bot User OAuth token (`xoxb-…`). Used for `chat.unfurl`. */
    botToken: z.string().describe('@sensitive Slack bot user OAuth token (xoxb-…)').default(''),
    /** App signing secret. Verifies inbound Events API requests (HMAC). */
    signingSecret: z.string().describe('@sensitive Slack app signing secret').default(''),
    /**
     * Carrier field for the "Generate Slack App manifest" admin button.
     * It holds no value — the `@action` marker tells the auto-form to
     * render a button that POSTs to `/manifest` and shows the JSON result.
     */
    manifest: z.string().describe('@action "Generate Slack App manifest" POST /manifest').default(''),
  })
  .strict();

type SlackConfig = z.infer<typeof SlackConfigSchema>;

/**
 * Resolve the public origin Slack must reach the inbound endpoint at.
 *
 * The wiki's base origin comes from core via `ctx.appInfo().baseUrl`
 * (sourced from `CLIENT_URL` / `getBaseUrl()`) — the plugin never reads
 * the env directly. In dev Slack cannot reach `localhost`, so an operator
 * running a tunnel (ngrok / cloudflared) sets `SLACK_MANIFEST_REQUEST_URL`
 * (a Slack-manifest-specific dev knob, not core app config) to that public
 * origin; when set it wins. Returns '' when nothing is configured.
 */
function resolveBaseUrl(ctx: PluginContext): string {
  const override = process.env.SLACK_MANIFEST_REQUEST_URL?.trim();
  if (override) {
    return override;
  }
  return ctx.appInfo().baseUrl;
}

/** Apply the current (decrypted) config to the module-scope Slack client. */
function applyConfig(ctx: PluginContext): void {
  const config = ctx.config<SlackConfig>();
  configureSlackClient(config.botToken);
  ctx.log.debug('configured slack client (botToken=%s)', config.botToken ? '<set>' : '<unset>');
}

const plugin: CrowiPlugin = {
  name: PLUGIN_NAME,
  version: '0.1.0-dev',
  configSchema: SlackConfigSchema,
  // Read-only: events.ts reads Page via ctx.model() to resolve the
  // page an inbound Slack event / unfurl refers to; no writes.
  modelAccess: ['Page'],
  adminPlacement: {
    // Phase 1 has no register* hook (registerNotifier lands in Phase 3), so
    // `deriveSectionFromHooks` would return empty — declare the section
    // explicitly. Slack is an external service integration, so it lives in
    // the "Platform services" sidebar section.
    section: 'platform',
    label: 'Slack',
    icon: 'slack',
  },

  // Localized help text for the config form. The `manifest` field is an
  // `@action` button; its description renders as a hint beneath the button
  // (URLs are linkified) pointing the operator at where to create the app.
  configI18n: {
    ja: {
      manifest: {
        description: 'Slack アプリの新規作成はこちら → https://api.slack.com/apps/ （"From an app manifest" を選び、生成した JSON を貼り付けてください）',
      },
    },
    en: {
      manifest: {
        description: 'Create a new Slack app → https://api.slack.com/apps/ (choose "From an app manifest" and paste the generated JSON).',
      },
    },
  },

  registerRoutes: (scope, ctx) => {
    // Prime the Slack client from boot-time config (registerRoutes runs at
    // boot, inside buildHonoApp).
    applyConfig(ctx);

    // Inbound Events API webhook — public (Crowi-auth bypassed); Slack's
    // request signature is the only authentication (verified inside the
    // handler). The raw body must reach the handler intact (Phase 0
    // guarantees no validator consumes it).
    scope.route('POST', EVENTS_ROUTE_PATH, (c) => handleSlackEvent(c, ctx, resolveBaseUrl(ctx)), { auth: 'public' });

    // `@action` target for the "Generate Slack App manifest" button —
    // admin-only, reached from the config form. Returns the manifest JSON
    // the operator pastes into Slack.
    scope.route(
      'POST',
      '/manifest',
      (c) => {
        const baseUrl = resolveBaseUrl(ctx);
        if (!baseUrl) {
          return c.json({ error: 'CLIENT_URL (or SLACK_MANIFEST_REQUEST_URL) is not set; cannot build a manifest.' }, 400);
        }
        // App name = the wiki's own name (core app:title); appInfo() already
        // defaults a blank title to 'Crowi', so this is always non-empty.
        return c.json(buildManifest({ baseUrl, wikiName: ctx.appInfo().title }));
      },
      { auth: 'admin' },
    );

    ctx.log.debug('registered slack routes (events + manifest)');
  },

  reconfigure: (ctx) => {
    applyConfig(ctx);
    ctx.log.debug('reconfigured slack client');
  },
};

export default plugin;

export { SlackConfigSchema };
export type { SlackConfig, SlackPluginConfig };
