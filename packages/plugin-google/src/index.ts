import { createOidcDriver, type CrowiPlugin, type PluginContext } from '@crowi/plugin-api';
import { z } from 'zod/v3';

/**
 * RFC-0014 phase 4 — Google sign-in as a plain vendor plugin.
 *
 * Deliberately thin. Google is NOT special-cased anywhere in core: there
 * is no `google:*` config namespace, no bespoke callback route, no
 * hand-rolled OAuth state or token exchange. Everything protocol-shaped
 * lives in the OIDC driver factory the SDK already provides (phase 0) and
 * the federated flow core already runs (phase 1), so this package only
 * supplies the three things that are genuinely Google-specific: where to
 * discover, what to ask for, and what to call the button.
 *
 * That is the whole point of the phase — proving the auth-provider plugin
 * contract is enough to add a real IdP without core learning its name.
 */

/** RFC-0014 §4 — Google's OIDC discovery document. */
const GOOGLE_DISCOVERY_URL = 'https://accounts.google.com/.well-known/openid-configuration';

/** RFC-0014 §4 — `openid` for OIDC itself, `email`/`profile` for the claims JIT provisioning needs (phase 2 requires a verified email). */
const GOOGLE_SCOPES = ['openid', 'email', 'profile'] as const;

/**
 * The driver slug. FIXED, not operator-configurable: it appears in
 * `/api/auth/providers/google/start` and is stored in every
 * `UserIdentity.provider`, so changing it would orphan existing links.
 */
const GOOGLE_DRIVER_NAME = 'google';

export const GoogleConfigSchema = z
  .object({
    clientId: z.string().trim().describe('Google OAuth client ID from the Google Cloud console').default(''),
    clientSecret: z.string().trim().describe('@sensitive Google OAuth client secret from the Google Cloud console').default(''),
  })
  .strict();

export type GoogleConfig = z.infer<typeof GoogleConfigSchema>;

/**
 * Read the credentials fresh on every call and hand back a COMPLETE pair
 * or nothing.
 *
 * Both halves matter. Reading per call (rather than capturing config at
 * registration) is what lets an operator paste credentials into the admin
 * form and have Google appear without a restart — the driver is always
 * registered, and its enablement is a property of the current config.
 * Returning `null` unless BOTH values are non-empty is what keeps a
 * half-configured provider off the login screen: core treats `null` as
 * "not configured" and omits it from the provider list entirely, so a
 * button that could only fail is never rendered.
 */
function readClientConfig(ctx: PluginContext): { clientId: string; clientSecret: string } | null {
  const { clientId, clientSecret } = ctx.config<GoogleConfig>();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export const plugin: CrowiPlugin = {
  name: '@crowi/plugin-google',
  version: '0.1.0-alpha.0',

  configSchema: GoogleConfigSchema,

  /**
   * The client id and secret are stored as ONE Config document rather than
   * a row each. A failure between two separate writes would leave the
   * instance holding a new client id next to the previous secret — a pair
   * that never existed, cannot authenticate, and is visible to every
   * replica until someone notices. See `CrowiPlugin.configAtomicGroups`.
   */
  configAtomicGroups: [{ name: 'clientCredentials', keys: ['clientId', 'clientSecret'], sensitive: true }],

  adminPlacement: { section: 'auth', label: 'Google', icon: 'key-round' },

  configI18n: {
    ja: {
      clientId: { label: 'クライアント ID', description: 'Google Cloud コンソールで発行した OAuth クライアント ID。' },
      clientSecret: { label: 'クライアントシークレット', description: 'Google Cloud コンソールで発行した OAuth クライアントシークレット。' },
    },
    en: {
      clientId: { label: 'Client ID', description: 'OAuth client ID issued in the Google Cloud console.' },
      clientSecret: { label: 'Client secret', description: 'OAuth client secret issued in the Google Cloud console.' },
    },
  },

  registerAuth: (registry, ctx) => {
    registry.register(
      GOOGLE_DRIVER_NAME,
      createOidcDriver({
        buttonLabel: 'Google',
        discoveryUrl: GOOGLE_DISCOVERY_URL,
        scopes: [...GOOGLE_SCOPES],
        // Passed as a function, never a captured value: see
        // `readClientConfig` for why enablement has to be re-evaluated per
        // request rather than frozen at registration.
        getClientConfig: () => readClientConfig(ctx),
      }),
    );
  },
};

export default plugin;
