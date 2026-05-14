import type { WsTokenPayload } from '@crowi/api-contract';
import { resolveApiDistFile } from './api-dist';

/**
 * Thin shape mirror of the Phase 2 helper exported from
 * `packages/api/src/util/ws-token.ts`. The actual implementation lives
 * in @crowi/api so sign + verify share one source of truth — this
 * module only re-resolves the dist file dynamically (same admin-cli
 * pattern used in `models.ts`) so we don't trigger the api package's
 * default export (which would auto-boot Express).
 */
export interface CollabWsTokenUtil {
  verifyWsToken(token: string): WsTokenPayload | null;
}

interface ApiWsTokenModule {
  createWsTokenUtil(): {
    verifyWsToken(token: string): WsTokenPayload | null;
  };
}

/**
 * Load the api package's `createWsTokenUtil()` and return its
 * `verifyWsToken` half (collab never signs). Caches the resolved
 * factory's util across calls so `WS_TOKEN_SECRET` is read once per
 * process — same lifecycle the api side enjoys.
 */
let cached: CollabWsTokenUtil | null = null;
export function getWsTokenUtil(): CollabWsTokenUtil {
  if (cached) return cached;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(resolveApiDistFile('util/ws-token.js')) as ApiWsTokenModule;
  const util = mod.createWsTokenUtil();
  cached = { verifyWsToken: util.verifyWsToken };
  return cached;
}

/**
 * Test helper: reset the cache between unit-test runs so a fresh
 * `WS_TOKEN_SECRET` env is honoured.
 */
export function _resetWsTokenUtilCacheForTesting(): void {
  cached = null;
}
