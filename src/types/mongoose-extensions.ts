import { Types } from 'mongoose'

// オブジェクトIDを文字列として扱うためのヘルパー関数
export function objectIdToString(id: Types.ObjectId | string | null | undefined): string {
  if (!id) return ''
  return id.toString()
}

// 文字列をObjectIdとして安全に変換するヘルパー関数
export function stringToObjectId(id: string | null | undefined): Types.ObjectId | null {
  if (!id) return null
  try {
    // @ts-ignore - TypeScriptの型定義が正しくないため無視
    return new Types.ObjectId(id)
  } catch (e) {
    return null
  }
}

// Mongooseモデル用の型ヘルパー
export type MongooseDocument<T> = T & {
  _id: Types.ObjectId
  createdAt?: Date
  updatedAt?: Date
}
