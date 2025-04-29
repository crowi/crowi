import { Request } from 'express';
import { ParsedQs } from 'qs';
import { Schema } from 'mongoose';
import { Session, SessionData } from 'express-session';

declare global {
  namespace Express {
    interface Request {
      search?: string;
      form?: any;
      config?: any;
      user?: any;
      session: Session & Partial<SessionData>;
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
    return query.length > 0 && (query[0] === 'true' || query[0] === true as any);
  }
  return Boolean(query);
}

// Query パラメータを ObjectId として安全に取得するためのヘルパー関数
export function getQueryAsObjectId(query: string | ParsedQs | (string | ParsedQs)[] | undefined): Schema.Types.ObjectId | null {
  const strValue = getQueryAsString(query);
  if (!strValue) return null;

  try {
    // Schema.Types.ObjectIdのコンストラクタは文字列を受け取れる
    return new Schema.Types.ObjectId(strValue);
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