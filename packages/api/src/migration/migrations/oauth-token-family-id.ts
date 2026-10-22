import { defineMigration } from '../types';

/**
 * Refresh tokens now belong to an immutable `familyId`. Rows minted before
 * that have no family and cannot be tied to one without guessing at the old
 * `rotatedTo` links, so every unrevoked family-less row is revoked and the
 * client signs in again. Already-revoked rows keep their original
 * `revokedAt`, which also makes a re-run (or a second replica running the
 * same update) a no-op for rows already handled.
 */
const FAMILYLESS_UNREVOKED = { revokedAt: null, $or: [{ familyId: null }, { familyId: '' }] };

export const oauthTokenFamilyId = defineMigration({
  id: 'oauth-token-family-id',
  fromVersion: '2.1',
  toVersion: '2.1',
  layer: 'boot',
  description: 'Revoke OAuth refresh tokens that predate familyId (clients sign in again)',

  isPending: async (ctx) => {
    const OAuthRefreshToken = ctx.crowi.model('OAuthRefreshToken');
    const legacy = await OAuthRefreshToken.findOne(FAMILYLESS_UNREVOKED).select('_id').lean().exec();
    return legacy != null;
  },

  detect: async (ctx) => {
    const OAuthRefreshToken = ctx.crowi.model('OAuthRefreshToken');
    const remaining = await OAuthRefreshToken.countDocuments(FAMILYLESS_UNREVOKED).exec();
    return {
      summary: `${remaining} unrevoked refresh token row(s) without familyId`,
      counts: { remaining },
    };
  },

  stages: [
    {
      name: 'revoke-familyless-refresh-tokens',
      fn: async (ctx) => {
        if (ctx.dryRun) {
          return { name: 'revoke-familyless-refresh-tokens', transformed: 0 };
        }
        const OAuthRefreshToken = ctx.crowi.model('OAuthRefreshToken');
        const result = await OAuthRefreshToken.updateMany(FAMILYLESS_UNREVOKED, { $set: { revokedAt: new Date() } });
        const modified = (result as { modifiedCount?: number }).modifiedCount ?? 0;
        if (modified > 0) {
          ctx.logger.info(`oauth-token-family-id: revoked ${modified} refresh token row(s) without familyId`);
        }
        return { name: 'revoke-familyless-refresh-tokens', transformed: modified };
      },
    },
  ],
});
