import type { Command } from 'commander';

import { authedFetch } from '../lib/http';
import { render, table } from '../lib/output';
import { requireProfile } from './_shared';

/**
 * The `GET /api/v2/auth/me` response (TokenMeResponseSchema). Parsed
 * leniently — the CLI accepts extra/missing fields for version-skew
 * tolerance, so this is a structural view, not a strict bind to the
 * generated `CrowiApiClient` type.
 */
interface AuthMeResponse {
  user?: {
    id?: string;
    username?: string;
    email?: string;
    name?: string;
    admin?: boolean;
  };
}

/**
 * `crowi whoami` — print the signed-in user. Uses `GET /api/v2/auth/me`
 * (JWT-authenticated but NOT scope-guarded), so it works under the default
 * `pages:read pages:write` token without needing `profile:read`. Also shows
 * the active profile + granted scope from the local store.
 */
export function registerWhoami(program: Command): void {
  program
    .command('whoami')
    .description('Show the signed-in user and active profile')
    .action(async (_options: unknown, command: Command) => {
      const { profile, globals } = requireProfile(command);
      const body = await authedFetch<AuthMeResponse>(profile, 'GET', '/auth/me');
      const user = body.user ?? {};

      render(
        { profile: profile.alias, endpoint: profile.endpoint, scope: profile.tokens?.scope, user },
        () => {
          const rows: Array<[string, string]> = [
            ['user', user.username ?? user.id ?? '(unknown)'],
            ['email', user.email ?? '-'],
            ['name', user.name ?? '-'],
            ['profile', profile.alias],
            ['endpoint', profile.endpoint],
            ['scope', profile.tokens?.scope ?? '-'],
          ];
          if (user.admin) {
            rows.push(['admin', 'yes']);
          }
          return table(rows);
        },
        globals,
      );
    });
}
