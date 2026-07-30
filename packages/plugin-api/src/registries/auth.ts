/**
 * Auth provider profile, normalised across providers (Google / GitHub /
 * future SAML / OIDC). Plugins map the upstream token / profile into
 * this shape; core looks up or provisions a User by `providerUserId`.
 */
export interface AuthProfile {
  /**
   * Stable identifier for this user *within the provider's namespace*.
   * Google: the `sub` claim. GitHub: the numeric account id as string.
   * Plugins must NEVER use email / username for this — those rotate.
   */
  providerUserId: string;
  /** Email address from the provider. May be empty if not granted. */
  email?: string;
  /** Display name from the provider. */
  name?: string;
  /** Avatar URL from the provider. */
  imageUrl?: string;
  /**
   * Free-form additional fields the plugin wants to persist on the
   * user document (e.g. github org membership). Stored under the
   * plugin's pageMetadata-style namespace on User.
   */
  extra?: Record<string, unknown>;
}

/**
 * Result of `verify` — either a normalised profile (success) or an
 * error reason the login UI surfaces.
 */
export type AuthVerifyResult = { ok: true; profile: AuthProfile } | { ok: false; reason: string };

/**
 * Auth provider driver. The login screen asks core for the list of
 * registered drivers and renders one button per driver
 * (`Sign in with Google`). Clicking redirects through the plugin's
 * registered routes (`/api/plugins/<name>/oauth/start`); the
 * provider redirects back to `/api/plugins/<name>/oauth/callback`,
 * which the plugin's contract handles.
 *
 * `verify` is the bridge: given whatever the plugin pulled out of the
 * callback (token / code / SAML response), produce a normalised
 * `AuthProfile` or a failure reason.
 */
export interface AuthDriver {
  /**
   * Human-readable label for the login button (e.g. `'Google'`).
   * Localisation is the plugin's responsibility — i18n keys can be
   * resolved by the plugin before registration.
   */
  buttonLabel: string;

  /** Optional icon URL for the login button. */
  iconUrl?: string;

  /**
   * Map provider-specific verification data into a normalised profile.
   * Called from inside the plugin's own callback route, with whatever
   * shape that route extracted. Typed as `unknown` here because the
   * shape is plugin-private.
   */
  verify(verificationData: unknown): Promise<AuthVerifyResult>;
}

export interface AuthRegistry {
  register(driverName: string, driver: AuthDriver): void;
}
