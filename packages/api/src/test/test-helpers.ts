/**
 * Shared test helpers for the Hono API integration test suite.
 *
 * Consolidates helpers that were copy-pasted across 20+ test files:
 *   - authHeaders / bearerAuthHeaders
 *   - createTestUser
 *   - createPageViaApi
 *
 * Consumers import from 'src/test/test-helpers'.
 *
 * NOTE: admin/users.test.ts keeps its own createTestUser because it uses the
 * seedUsers+ownedUserIds tracking mechanism required for exact pagination/count
 * assertions. That variant calls this module's authHeaders but manages user
 * creation itself.
 */
import sharp from 'sharp';
import type { UserDocument } from 'src/models/user';
import { createJwtUtil } from 'src/util/jwt';
import request from 'supertest';

import { app, crowi, Fixture } from './setup';

// ---------------------------------------------------------------------------
// Auth headers
// ---------------------------------------------------------------------------

/**
 * Standard JSON request headers with Bearer token.
 * Use this for the vast majority of JSON API calls.
 */
export const authHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

/**
 * Bearer-token-only headers — no Content-Type.
 * Use this for multipart / binary uploads where Content-Type must not be set
 * to `application/json` (e.g. attachment upload tests).
 */
export const bearerAuthHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

/**
 * `crowi.accessToken` cookie header — the headerless fallback credential
 * (feature-auth-cookie-fallback-scope). Only ever an `access` (web-session)
 * JWT; never a PAT or `oauth_access` token.
 */
export const cookieAuthHeaders = (token: string): Record<string, string> => ({
  Cookie: `crowi.accessToken=${token}`,
});

// ---------------------------------------------------------------------------
// createTestUser
// ---------------------------------------------------------------------------

export interface CreateTestUserInfo {
  name: string;
  username: string;
  email: string;
  admin?: boolean;
  googleId?: string | null;
  githubId?: string | null;
}

/**
 * Generate a Fixture user, set STATUS_ACTIVE, optionally make admin / set
 * OAuth IDs, persist, and mint a JWT access token — returning both the
 * Mongoose document and the token string.
 *
 * For files that need extra tracking (e.g. admin/users.test.ts pagination
 * counts) keep a local wrapper that calls Fixture.generate + ownedUserIds
 * tracking and then issues the JWT via createJwtUtil — do not use this
 * function there.
 */
export const createTestUser = async (info: CreateTestUserInfo): Promise<{ user: UserDocument; accessToken: string }> => {
  const User = crowi.model('User');
  const [user] = (await Fixture.generate('User', [info])) as [UserDocument];
  user.status = User.STATUS_ACTIVE;
  if (info.admin !== undefined) user.admin = !!info.admin;
  if (info.googleId !== undefined) (user as UserDocument & { googleId: string | null }).googleId = info.googleId;
  if (info.githubId !== undefined) (user as UserDocument & { githubId: string | null }).githubId = info.githubId;
  await user.save();
  const accessToken = createJwtUtil(crowi).generateTokens(user).accessToken;
  return { user, accessToken };
};

// ---------------------------------------------------------------------------
// createPageViaApi
// ---------------------------------------------------------------------------

/**
 * Seed a page via the API (POST /api/pages) and return its id + path.
 *
 * All parameters after `body` are optional:
 *   - `grant`: numeric grant value (omit to use the server default)
 *
 * The response body is cast to `{ _id: string; path: string }`. If a caller
 * needs additional fields (e.g. `revision._id` in backlink tests) it should
 * cast the return value locally:
 *
 *   const page = await createPageViaApi(...) as { _id: string; path: string; revision: { _id: string } };
 */
export const createPageViaApi = async (accessToken: string, path: string, body: string, grant?: number): Promise<{ _id: string; path: string }> => {
  const payload: Record<string, unknown> = { path, body };
  if (grant !== undefined) payload.grant = grant;
  const res = await request(app).post('/api/pages').set(authHeaders(accessToken)).send(payload);
  if (res.status !== 200) {
    throw new Error(`Failed to seed page (${path}): ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.page as { _id: string; path: string };
};

// ---------------------------------------------------------------------------
// createWideJpeg
// ---------------------------------------------------------------------------

/**
 * A synthetic 2000x1000 JPEG buffer wide enough (> `TARGET_MAX_WIDTH`, see
 * `util/image-display-derivative.ts`) to force `mode: 'resized'` display
 * derivative generation in attachment upload tests.
 */
export const createWideJpeg = (background: { r: number; g: number; b: number } = { r: 10, g: 20, b: 30 }): Promise<Buffer> =>
  sharp({ create: { width: 2000, height: 1000, channels: 3, background } })
    .jpeg()
    .toBuffer();
