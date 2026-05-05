import { Types } from 'mongoose';
import type { PageUser } from '@crowi/api-contract';

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
 * Strict 24-character hex string check for Mongo ObjectId.
 * `Types.ObjectId.isValid()` accepts 12-byte buffers and other formats; we
 * only accept the canonical hex string used in URLs and request bodies.
 */
export const isValidObjectId = (id: string | undefined | null): id is string => typeof id === 'string' && /^[0-9a-f]{24}$/.test(id);
