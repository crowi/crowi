import { Types } from 'mongoose';
import type { PageUser, UserPublic } from '@crowi/api-contract';
import type { UserDocument } from 'src/models/user';
import type { PageDocument } from 'src/models/page';

/**
 * Shape of a populated User as it appears on Mongoose documents that have
 * `creator` / `lastUpdateUser` / `revision.author` populated.
 */
export interface PopulatedUser {
  _id: Types.ObjectId;
  username: string;
  name: string;
  email: string;
  image?: string | null;
  createdAt?: Date;
}

export const toISOStringOrNull = (date: Date | undefined | null): string | null => {
  if (!date) return null;
  return date instanceof Date ? date.toISOString() : String(date);
};

export const toStringId = (id: Types.ObjectId | string): string => {
  return typeof id === 'string' ? id : id.toString();
};

export const toPageUser = (user: PopulatedUser): PageUser => ({
  _id: user._id.toString(),
  id: user._id.toString(),
  username: user.username,
  name: user.name,
  email: user.email,
  image: user.image || null,
  createdAt: toISOStringOrNull(user.createdAt) || new Date().toISOString(),
});

/**
 * Looser shape than UserDocument: covers populated subdocuments where _id may
 * already be a string and most fields can be missing. Falls back gracefully so
 * the response payload always satisfies UserPublicSchema.
 */
export interface PopulatedUserPublic {
  _id: Types.ObjectId | string;
  username?: string;
  name?: string;
  email?: string;
  image?: string | null;
  introduction?: string;
  createdAt?: Date;
  admin?: boolean;
  status?: number;
}

export const toUserPublic = (user: UserDocument | PopulatedUserPublic): UserPublic => ({
  _id: toStringId(user._id),
  id: toStringId(user._id),
  username: user.username ?? '',
  name: user.name ?? '',
  email: user.email ?? '',
  image: user.image ?? null,
  introduction: user.introduction ?? '',
  createdAt: toISOStringOrNull(user.createdAt) ?? new Date().toISOString(),
  admin: user.admin ?? false,
  status: user.status,
});

/**
 * Strict 24-character hex string check for Mongo ObjectId.
 * `Types.ObjectId.isValid()` accepts 12-byte buffers and other formats; we
 * only accept the canonical hex string used in URLs and request bodies.
 */
export const isValidObjectId = (id: string | undefined | null): id is string => typeof id === 'string' && /^[0-9a-f]{24}$/.test(id);

/**
 * Heuristic for "this is a populated user document, not just an ObjectId".
 * The 4 ts-rest routes all need this; the loose form (only _id + username +
 * email) covers all current call sites.
 */
export const isPopulatedUser = (value: unknown): value is PopulatedUser => {
  return !!value && typeof value === 'object' && '_id' in value && 'username' in value && 'email' in value;
};

/**
 * Standard 404 for "page not found OR not granted". Mapped to 404 (not 403)
 * so we do not leak page existence to callers without grant.
 */
export const pageNotFoundResponse = {
  status: 404 as const,
  body: { error: { code: 'PAGE_NOT_FOUND' as const, message: 'Page not found' as const } },
} as const;

/**
 * Standard 400 for an invalid page_id (not 24-char hex).
 */
export const invalidPageIdResponse = {
  status: 400 as const,
  body: { error: { code: 'INVALID_PAGE_ID' as const, message: 'Invalid page_id' } },
} as const;

/**
 * Standard 500 for an unexpected handler failure. Used by every admin
 * handler that wraps its body in try/catch and needs to surface a typed
 * `InternalServerError` shape (see `schemas/common.ts:InternalServerErrorSchema`).
 */
export const internalServerErrorResponse = {
  status: 500 as const,
  body: { error: { code: 'INTERNAL_ERROR' as const, message: 'Internal server error' as const } },
} as const;

/**
 * Minimum surface of the Page model that loadGrantedPage needs. We avoid
 * importing the full Page model type because crowi.model('Page') returns
 * a Mongoose Model with deeply-nested generics that would force every
 * caller to mirror the same type.
 */
interface PageModelLike {
  findPageByIdAndGrantedUser(pageId: string, user: UserDocument): Promise<PageDocument | null>;
}

export type LoadedGrantedPage = { page: PageDocument } | { error: typeof pageNotFoundResponse | typeof invalidPageIdResponse };

/**
 * Validate `pageId` and resolve a granted Page document, or return the
 * standard 400 / 404 response otherwise. Centralises the
 * isValidObjectId + findPageByIdAndGrantedUser + leak-prevention catch
 * pattern that ts-rest page-related routes (page / bookmark / comment /
 * revision / notification) all need.
 */
export const loadGrantedPage = async (Page: PageModelLike, pageId: string, user: UserDocument): Promise<LoadedGrantedPage> => {
  if (!isValidObjectId(pageId)) {
    return { error: invalidPageIdResponse };
  }
  try {
    const page = await Page.findPageByIdAndGrantedUser(pageId, user);
    if (!page) return { error: pageNotFoundResponse };
    return { page };
  } catch {
    return { error: pageNotFoundResponse };
  }
};
