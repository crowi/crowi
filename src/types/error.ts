// Mongoose や Express などでよく使われるエラー型の定義
export interface CustomError extends Error {
  code?: number | string
  errors?: {
    [key: string]: {
      message: string
      [key: string]: any
    }
  }
  status?: number
  statusCode?: number
  stack?: string
}

// エラーを安全に型変換するためのヘルパー関数
export function asCustomError(err: unknown): CustomError {
  if (err instanceof Error) {
    return err as CustomError
  }

  // エラーでない場合は新しいエラーを作成
  const customError = new Error(typeof err === 'string' ? err : 'Unknown error')
  return customError as CustomError
}
