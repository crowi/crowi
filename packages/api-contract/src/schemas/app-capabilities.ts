/**
 * Single source of truth for the static capability baseline + API surface
 * version advertised at `GET /api/v2/app/info` and consumed by the
 * `@crowi/cli` end-user CLI for feature detection / version-skew warnings.
 *
 * These two values are deliberately shared between the API handler
 * (`packages/api/src/hono/handlers/app.ts`) and the CLI
 * (`packages/cli/src/lib/capability.ts`) so the "always-on" set and the
 * floor version can never drift apart silently. Dynamically-detected
 * capabilities (e.g. `search`, `collab`) are NOT listed here — the handler
 * appends those at runtime based on live server state.
 */

/**
 * Subsystems unconditionally compiled into `@crowi/api`. An old CLI talking
 * to a new server, and a new CLI talking to a server that omits
 * `capabilities`, both degrade to this baseline. OAuth (RFC-0010) is fully
 * landed and the page / comment / bookmark / attachment / notification
 * handlers are always mounted, so these are always-on.
 */
export const STATIC_CAPABILITIES = [
  'oauth',
  'oauth:auth-code',
  'oauth:device',
  'oauth:pkce',
  'pat',
  'pages',
  'comments',
  'bookmarks',
  'attachments',
  'notifications',
] as const;

/**
 * The API surface version advertised in `app/info.apiVersion` and the
 * version the CLI is built against (the "v2 floor"). A mismatch drives a
 * WARN-ONLY skew note in the CLI — never a refusal.
 */
export const API_SURFACE_VERSION = 'v2';
