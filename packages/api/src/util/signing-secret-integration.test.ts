/**
 * feature-unified-signing-secret — cross-channel integration coverage for
 * the unified `SECRET_TOKEN` resolver. Per-channel unit coverage lives in
 * each channel's own `*.test.ts` (jwt via `hono/middleware/auth.test.ts`,
 * federated-auth-state via `federated-auth-state.test.ts`, ws/presence/
 * notifications/mail via `signed-token-factory.test.ts` and their own
 * files); this file is the cross-channel matrix (AC-4) plus the
 * child-process boot-failure contract (AC-11).
 */

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import path from 'node:path';
import type { Readable } from 'node:stream';
import jwt from 'jsonwebtoken';
import type Crowi from 'src/crowi';
import { withSecretTokenEnv } from 'src/test/secret-token-env';
import { FAIL_MARKER_PREFIX } from 'src/util/boot-reporter';
import { createFederatedAuthStateUtil } from 'src/util/federated-auth-state';
import { createJwtUtil } from 'src/util/jwt';
import { createMailTokenUtil } from 'src/util/mail-token';
import { createNotificationsTokenUtil } from 'src/util/notifications-token';
import { createPresenceTokenUtil } from 'src/util/presence-token';
import { createWsTokenUtil } from 'src/util/ws-token';

/**
 * Minimal `Crowi` stub for `createJwtUtil`: carries neither `getConfig` nor
 * a usable `model` — feature-unified-signing-secret §D-3 removed
 * `createJwtUtil`'s DB config dependency for `generateTokens` /
 * `signOauthAccessToken` / `verifyToken`, so this stub existing (and being
 * enough) is itself the regression guard: a reintroduced `crowi.getConfig()`
 * call would throw `TypeError: crowi.getConfig is not a function` the
 * moment any test below calls `createJwtUtil(makeConfigFreeCrowi())`.
 * `refreshAccessToken` (which DOES need `crowi.model`) is not exercised by
 * any test in this file.
 */
function makeConfigFreeCrowi(): Crowi {
  return {} as unknown as Crowi;
}

const FAKE_USER = { _id: { toString: () => 'user-1' }, email: 'user-1@example.com', authVersion: 0 };

describe('signing-secret-integration (feature-unified-signing-secret)', () => {
  describe('AC-4(a): 5-issuer replay matrix — collab / presence / notifications / mail (4 distinct wrapper issuers) plus the shared "crowi" issuer (Web session access, minted here as the session representative — AC-4(b) below covers refresh/oauth_access sharing the same issuer) all reject cross-issuer replay under the SAME shared secret', () => {
    type Channel = 'collab' | 'presence' | 'notifications' | 'mail' | 'session';

    function mintAll(): Record<Channel, string> {
      const jwtUtil = createJwtUtil(makeConfigFreeCrowi());
      return {
        collab: createWsTokenUtil().signWsToken({ userId: 'user-1', pageId: 'page-1', readonly: false, epoch: 0 }).token,
        presence: createPresenceTokenUtil().signPresenceToken({ userId: 'user-1', pageId: 'page-1' }).token,
        notifications: createNotificationsTokenUtil().signNotificationsToken({ selfUserId: 'user-1' }).token,
        mail: createMailTokenUtil().signMailToken({ purpose: 'reset', userId: 'user-1', email: 'user-1@example.com' }).token,
        session: jwtUtil.generateTokens(FAKE_USER).accessToken,
      };
    }

    // The `session` verifier uses the middleware's own accepted-types-array
    // form (`hono/middleware/auth.ts`) rather than a single type, so this
    // matrix also proves the property that matters operationally: a leaked
    // wrapper-channel token (collab/presence/notifications/mail) must never
    // be accepted by the Bearer middleware for ANY of the "crowi"-issuer
    // token types, not just `access`.
    const verifiers: Record<Channel, (token: string) => unknown> = {
      collab: (t) => createWsTokenUtil().verifyWsToken(t),
      presence: (t) => createPresenceTokenUtil().verifyPresenceToken(t),
      notifications: (t) => createNotificationsTokenUtil().verifyNotificationsToken(t),
      mail: (t) => createMailTokenUtil().verifyMailToken(t, 'reset'),
      session: (t) => createJwtUtil(makeConfigFreeCrowi()).verifyToken(t, ['access', 'oauth_access', 'refresh']),
    };

    it('every issuer verifies its own token', () => {
      const tokens = mintAll();
      for (const channel of Object.keys(tokens) as Channel[]) {
        expect(verifiers[channel](tokens[channel])).not.toBeNull();
      }
    });

    it('every non-matching (mint-issuer, verify-issuer) pair rejects — a leaked token from one issuer is never replayable against another', () => {
      const tokens = mintAll();
      for (const mintChannel of Object.keys(tokens) as Channel[]) {
        for (const verifyChannel of Object.keys(verifiers) as Channel[]) {
          if (verifyChannel === mintChannel) continue;
          expect(verifiers[verifyChannel](tokens[mintChannel])).toBeNull();
        }
      }
    });
  });

  describe('AC-4(b): Web session access/refresh and OAuth access share issuer "crowi" — separated by token TYPE, not issuer', () => {
    it('all three decode under the SAME issuer/secret, but verifyToken enforces the type boundary', () => {
      const jwtUtil = createJwtUtil(makeConfigFreeCrowi());
      const { accessToken, refreshToken } = jwtUtil.generateTokens(FAKE_USER);
      const oauthAccessToken = jwtUtil.signOauthAccessToken({ user: FAKE_USER, scopes: ['read'], clientId: 'client-1' });

      // The raw JWT layer alone does not separate them — all three carry
      // the same issuer.
      for (const token of [accessToken, refreshToken, oauthAccessToken]) {
        const [, payloadB64] = token.split('.');
        const decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
        expect(decoded.iss).toBe('crowi');
      }

      expect(jwtUtil.verifyToken(accessToken, 'access')?.type).toBe('access');
      expect(jwtUtil.verifyToken(accessToken, 'refresh')).toBeNull();
      expect(jwtUtil.verifyToken(refreshToken, 'refresh')?.type).toBe('refresh');
      expect(jwtUtil.verifyToken(refreshToken, 'access')).toBeNull();
      expect(jwtUtil.verifyToken(oauthAccessToken, 'oauth_access')?.type).toBe('oauth_access');
      expect(jwtUtil.verifyToken(oauthAccessToken, 'access')).toBeNull();

      // The unified Bearer middleware's accepted-types-array form
      // (`hono/middleware/auth.ts`) — session access and OAuth access are
      // BOTH acceptable to a handler that opts in to both; refresh never is.
      expect(jwtUtil.verifyToken(accessToken, ['access', 'oauth_access'])).not.toBeNull();
      expect(jwtUtil.verifyToken(oauthAccessToken, ['access', 'oauth_access'])).not.toBeNull();
      expect(jwtUtil.verifyToken(refreshToken, ['access', 'oauth_access'])).toBeNull();
    });
  });

  describe('AC-4(c): OAuth sign-in state is not a JWT — no issuer, an HKDF subkey instead of the raw secret', () => {
    it('a state cookie value is not a verifiable JWT under the shared secret', () => {
      const stateUtil = createFederatedAuthStateUtil({ node_env: 'production' });
      const cookieValue = stateUtil.issue({ state: 'state-1', provider: 'test-provider', continuePath: '/dashboard', handoffJkt: 'jkt-1' });
      expect(() => jwt.verify(cookieValue, process.env.SECRET_TOKEN as string)).toThrow();
    });

    it('a Web session JWT is not a valid state cookie value', () => {
      const jwtUtil = createJwtUtil(makeConfigFreeCrowi());
      const { accessToken } = jwtUtil.generateTokens(FAKE_USER);
      const stateUtil = createFederatedAuthStateUtil({ node_env: 'production' });
      expect(stateUtil.verify(accessToken, 'test-provider')).toBeNull();
    });
  });

  describe('AC-1/AC-9: production signing paths have no Config/DB dependency', () => {
    it('createJwtUtil never calls getConfig — a Crowi stub carrying neither getConfig nor a usable model still mints/verifies', () => {
      const jwtUtil = createJwtUtil(makeConfigFreeCrowi());
      const { accessToken } = jwtUtil.generateTokens(FAKE_USER);
      expect(jwtUtil.verifyToken(accessToken, 'access')).not.toBeNull();
    });

    it('createFederatedAuthStateUtil takes only Pick<Crowi, "node_env"> — no getConfig/DB dependency', () => {
      const util = createFederatedAuthStateUtil({ node_env: 'development' });
      const cookieValue = util.issue({ state: 's', provider: 'p', continuePath: '/x', handoffJkt: 'j' });
      expect(util.verify(cookieValue, 'p')).not.toBeNull();
    });
  });

  describe('raw whitespace-padded legacy WS_TOKEN_SECRET continuity across every channel (D-7: an existing valid legacy alias keeps working after this change)', () => {
    it('Web session JWT', () => {
      withSecretTokenEnv({ SECRET_TOKEN: undefined, WS_TOKEN_SECRET: '  padded-legacy-secret-for-jwt-continuity-32c  ' }, () => {
        const { accessToken } = createJwtUtil(makeConfigFreeCrowi()).generateTokens(FAKE_USER);
        expect(createJwtUtil(makeConfigFreeCrowi()).verifyToken(accessToken, 'access')).not.toBeNull();
      });
    });

    it('OAuth sign-in state', () => {
      withSecretTokenEnv({ SECRET_TOKEN: undefined, WS_TOKEN_SECRET: '  padded-legacy-secret-for-state-continuity-32c  ' }, () => {
        const cookieValue = createFederatedAuthStateUtil({ node_env: 'production' }).issue({
          state: 's',
          provider: 'p',
          continuePath: '/x',
          handoffJkt: 'j',
        });
        expect(createFederatedAuthStateUtil({ node_env: 'production' }).verify(cookieValue, 'p')).not.toBeNull();
      });
    });

    it('collab / presence / notifications / mail', () => {
      withSecretTokenEnv({ SECRET_TOKEN: undefined, WS_TOKEN_SECRET: '  padded-legacy-secret-for-channel-continuity-32c  ' }, () => {
        const wsToken = createWsTokenUtil().signWsToken({ userId: 'u', pageId: 'p', readonly: false, epoch: 0 }).token;
        expect(createWsTokenUtil().verifyWsToken(wsToken)).not.toBeNull();

        const presenceToken = createPresenceTokenUtil().signPresenceToken({ userId: 'u', pageId: 'p' }).token;
        expect(createPresenceTokenUtil().verifyPresenceToken(presenceToken)).not.toBeNull();

        const notifToken = createNotificationsTokenUtil().signNotificationsToken({ selfUserId: 'u' }).token;
        expect(createNotificationsTokenUtil().verifyNotificationsToken(notifToken)).not.toBeNull();

        const mailToken = createMailTokenUtil().signMailToken({ purpose: 'reset', userId: 'u', email: 'u@example.com' }).token;
        expect(createMailTokenUtil().verifyMailToken(mailToken, 'reset')).not.toBeNull();
      });
    });
  });

  describe('AC-11: booting packages/api/src/app.ts with an invalid signing secret prints the fail marker before a non-zero exit', () => {
    /** Absolute path to `packages/api` — the child's `cwd` (matches the real `start`/`dev` scripts' project root). */
    const API_PACKAGE_DIR = path.resolve(__dirname, '..', '..');
    /** `packages/api/src/app.ts`, passed relative to `API_PACKAGE_DIR` since that is the child's cwd. */
    const APP_ENTRY_RELATIVE_PATH = path.join('src', 'app.ts');
    /** Any port other than the dev api's default (4301) — the child should never reach `server.listen()` at all, but this keeps a false-negative pass from colliding with a real dev server if it somehow did. */
    const CHILD_PORT = '14999';

    interface RunAppResult {
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    }

    /**
     * Spawns `packages/api/src/app.ts` as a genuinely separate OS process via
     * `tsx` (same `--import` loader approach as
     * `rebuild-attachment-display-derivatives-sigint-harness.ts`'s runner),
     * with `cwd` fixed to `packages/api` and an explicitly-built env
     * (`{ ...process.env, ...overrides }` — never bare inheritance, per
     * `rebuild-attachment-display-derivatives.test.ts`'s own precedent).
     */
    function runAppWithEnv(overrides: Record<string, string>): Promise<RunAppResult> {
      return new Promise((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const tsxLoaderPath = require.resolve('tsx');
        const child: ChildProcessByStdio<null, Readable, Readable> = spawn(process.execPath, ['--import', tsxLoaderPath, APP_ENTRY_RELATIVE_PATH], {
          cwd: API_PACKAGE_DIR,
          env: { ...process.env, ...overrides, PORT: CHILD_PORT },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
      });
    }

    it('SECRET_TOKEN and WS_TOKEN_SECRET both set to the known placeholder "changeme" fails boot with the @@crowi:fail marker and a non-zero exit', async () => {
      // "unset" is built from an explicit known placeholder on BOTH keys,
      // not by deleting them: `app.ts`'s `dotenv.config()` does not
      // override an already-set env var, but it DOES fill in one that is
      // genuinely absent — a repo-root `.env` carrying a real
      // `WS_TOKEN_SECRET` would otherwise silently re-inject a valid
      // secret and the child would actually boot.
      const result = await runAppWithEnv({ SECRET_TOKEN: 'changeme', WS_TOKEN_SECRET: 'changeme' });
      expect(result.code).not.toBe(0);
      expect(result.stdout).toContain(FAIL_MARKER_PREFIX);
      expect(result.stdout).toMatch(new RegExp(`${FAIL_MARKER_PREFIX} api `));
      expect(result.stdout).not.toContain('changeme');
    }, 30000);
  });
});
