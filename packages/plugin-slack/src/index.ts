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
 * `CLIENT_URL` (= `crowi.getBaseUrl()`) is the SSOT in production, but in
 * dev Slack cannot reach `localhost`, so an operator running a tunnel
 * (ngrok / cloudflared) sets `SLACK_MANIFEST_REQUEST_URL` to that public
 * origin and the manifest's `request_url` is built from it. When unset,
 * we fall back to `CLIENT_URL`.
 */
function resolveBaseUrl(): string | null {
  const override = process.env.SLACK_MANIFEST_REQUEST_URL?.trim();
  if (override) {
    return override;
  }
  // `getBaseUrl()` is not on the thin PluginContext surface; read CLIENT_URL
  // directly (the same env it is sourced from) so the plugin stays decoupled
  // from `@crowi/server`.
  return process.env.CLIENT_URL?.trim() || null;
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
  adminPlacement: {
    // Phase 1 has no register* hook (registerNotifier lands in Phase 3), so
    // `deriveSectionFromHooks` would return empty — declare the section
    // explicitly so the plugin appears in the admin sidebar.
    section: 'notification',
    label: 'Slack',
    icon: 'bell',
  },

  registerRoutes: (scope, ctx) => {
    // Prime the Slack client from boot-time config (registerRoutes runs at
    // boot, inside buildHonoApp).
    applyConfig(ctx);

    // Inbound Events API webhook — public (Crowi-auth bypassed); Slack's
    // request signature is the only authentication (verified inside the
    // handler). The raw body must reach the handler intact (Phase 0
    // guarantees no validator consumes it).
    scope.route('POST', EVENTS_ROUTE_PATH, (c) => handleSlackEvent(c, ctx, resolveBaseUrl()), { public: true });

    // `@action` target for the "Generate Slack App manifest" button —
    // authed (admin-only, reached from the config form). Returns the
    // manifest JSON the operator pastes into Slack.
    scope.route('POST', '/manifest', (c) => {
      const baseUrl = resolveBaseUrl();
      if (!baseUrl) {
        return c.json({ error: 'CLIENT_URL (or SLACK_MANIFEST_REQUEST_URL) is not set; cannot build a manifest.' }, 400);
      }
      // App name = the wiki's own name (core app:title); appInfo() already
      // defaults a blank title to 'Crowi', so this is always non-empty.
      return c.json(buildManifest({ baseUrl, wikiName: ctx.appInfo().title }));
    });

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
