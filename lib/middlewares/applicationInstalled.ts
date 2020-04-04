import { Request, Response, NextFunction } from 'express'

export default () => {
  return (req: Request, res: Response, next: NextFunction) => {
    var config = req.config

    if (Object.keys(config.crowi).length === 1) {
      // app:url is set by process
      return res.redirect('/installer')
    }

    return next()
  }
}
