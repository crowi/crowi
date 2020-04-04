
import * as core from 'express-serve-static-core'
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
  }
  interface Response {
  }
}