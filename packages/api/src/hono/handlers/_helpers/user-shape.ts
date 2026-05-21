/**
 * Shared user-shape helpers used by Hono handlers that translate a
 * Mongoose `UserDocument` to the wire. Two concerns:
 *
 *  - `toUserImage(image)` collapses Mongoose's `null | string |
 *    undefined` representation to `string | undefined` (the OpenAPI
 *    schemas declare `z.string().optional()` and Hono's typed-response
 *    check rejects `null`). Reused by `tokenAuth.ts` / `me.ts` /
 *    `user.ts` wherever a user image surfaces.
 *  - `toAuthUser(user)` produces the `{ id, username, email, name,
 *    image, admin }` envelope shared by `TokenAuthResponseSchema` and
 *    `TokenMeResponseSchema`. `me` and `user` resources expose
 *    *different* response shapes (profile envelope with `lang` /
 *    `googleId` etc. for me, `UserPublic` projection for user) so they
 *    do not share this helper, only `toUserImage`.
 */
import type { UserDocument } from 'src/models/user';

/**
 * Convert Mongoose's `null | string` `user.image` to the contract-friendly
 * `string | undefined`. The Hono `c.json` typed-response check rejects
 * `null` against `z.string().optional()`, so we explicitly coerce.
 */
export const toUserImage = (image: string | null | undefined): string | undefined => image ?? undefined;

/**
 * Subset of `UserDocument` required to build an `AuthUser` envelope.
 * Declared loosely so populated subdocs (e.g. `revision.author`) work as
 * well as the full Mongoose document.
 */
export type AuthUserLike = Pick<UserDocument, 'username' | 'email' | 'name'> & {
  _id: { toString(): string };
  image?: string | null;
  admin?: boolean;
};

/**
 * `TokenAuthResponseSchema.user` / `TokenMeResponseSchema.user` shape.
 */
export const toAuthUser = (user: AuthUserLike) => ({
  id: user._id.toString(),
  username: user.username,
  email: user.email,
  name: user.name,
  image: toUserImage(user.image),
  admin: user.admin === true,
});
