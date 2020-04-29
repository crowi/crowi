
import * as core from 'express-serve-static-core'
import { i18n } from 'i18next';
import { UserDocument } from 'server/models/user';

declare module "express-serve-static-core" {
  interface Request {
      user?: UserDocument | null
      skipCsrfVerify?: boolean
      csrfToken?: string | null
      config?: any
      form: any
      session: Express.Session & {
        user?: UserDocument | null
        callback?: string | null
      }
      flash: Function
      i18n: i18n
      t: Function
      language?: string
  }
  interface Response {
  }
}