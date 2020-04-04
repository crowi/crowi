import { Express } from 'express'
import Crowi from 'server/crowi'

import AccessTokenParser from './accessTokenParser'
import AdminRequired from './adminRequired'
import ApplicationInstalled from './applicationInstalled'
import ApplicationNotInstalled from './applicationNotInstalled'
import BasicAuth from './basicAuth'
import CsrfVerify from './csrfVerify'
import EncodeSpace from './encodeSpace'
import FileAccessRightOrLoginRequired from './fileAccessRightOrLoginRequired'
import I18next from './i18next'
import LoginChecker from './loginChecker'
import LoginRequired from './loginRequired'
import SwigFilters from './swigFilters'
import SwigFunctions from './swigFunctions'

export default (crowi: Crowi, app: Express) => ({
  AccessTokenParser: AccessTokenParser(crowi, app),
  AdminRequired: AdminRequired(),
  ApplicationInstalled: ApplicationInstalled(),
  ApplicationNotInstalled: ApplicationNotInstalled(),
  BasicAuth: BasicAuth(crowi, app),
  CsrfVerify: CsrfVerify(crowi),
  EncodeSpace: EncodeSpace(),
  FileAccessRightOrLoginRequired: FileAccessRightOrLoginRequired(crowi),
  I18next: I18next(crowi, app),
  LoginChecker: LoginChecker(crowi, app),
  LoginRequired: LoginRequired(crowi),
  SwigFilters: SwigFilters(crowi, app),
  SwigFunctions: SwigFunctions(crowi, app),
})
