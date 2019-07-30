import { Request, Response } from 'express'
import { LanguageDetectorInterfaceOptions } from 'i18next-express-middleware';

export default {
  name: 'userSettingDetector',

  lookup(req: Request, res: Response, options?: LanguageDetectorInterfaceOptions) {
    let lang = null

    if (req.user) {
      if ('lang' in req.user) {
        lang = req.user.lang || null
      }
    }

    return lang
  },

  cacheUserlanguage(req, res, lng, options) {
    // nothing to do
  },
}
