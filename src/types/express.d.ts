import { Request } from 'express';
import { ParsedQs } from 'qs';
import { Types } from 'mongoose';

declare global {
  namespace Express {
    interface Request {
      search?: string;
      form?: any;
      config?: any;
      user?: any;
      session: any;
    }
  }
}

// Query パラメータを string として安全に取得するためのヘルパー関数
export function getQueryAsString(query: string | ParsedQs | (string | ParsedQs)[] | undefined): string {
  if (query === undefined) return '';
  if (typeof query === 'string') return query;
  if (Array.isArray(query)) {
    return query.length > 0 && typeof query[0] === 'string' ? query[0] : '';
  }
  return String(query);
}

// Query パラメータを boolean として安全に取得するためのヘルパー関数
export function getQueryAsBoolean(query: string | ParsedQs | (string | ParsedQs)[] | undefined): boolean {
  if (query === undefined) return false;
  if (typeof query === 'string') return query === 'true';
  if (Array.isArray(query)) {
    return query.length > 0 && (query[0] === 'true' || query[0] === true);
  }
  return Boolean(query);
}

// Query パラメータを ObjectId として安全に取得するためのヘルパー関数
export function getQueryAsObjectId(query: string | ParsedQs | (string | ParsedQs)[] | undefined): Types.ObjectId | null {
  const strValue = getQueryAsString(query);
  if (!strValue) return null;

  try {
    return new Types.ObjectId(strValue);
  } catch (e) {
    return null;
  }
}

// Query パラメータを number として安全に取得するためのヘルパー関数
export function getQueryAsNumber(query: string | ParsedQs | (string | ParsedQs)[] | undefined, defaultValue = 0): number {
  if (query === undefined) return defaultValue;

  const value = parseInt(getQueryAsString(query), 10);
  return isNaN(value) ? defaultValue : value;
}