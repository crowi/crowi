import { Request, Response } from 'express'
import { LanguageDetectorInterfaceOptions } from 'i18next-express-middleware'

export default {
  name: 'userSettingDetector',

  lookup(req: Request, res: Response, options?: LanguageDetectorInterfaceOptions) {
    let lang = ''
    const { user } = req as any

    if (user) {
      if ('lang' in user) {
        lang = user.lang || null
      }
    }

    return lang
  },

  cacheUserlanguage(req: Request, res: Response, lng, options) {
    // nothing to do
  },
}
