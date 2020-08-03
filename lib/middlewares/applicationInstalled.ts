import { Request, Response, NextFunction } from 'express'

export default () => {
  return (req: Request, res: Response, next: NextFunction) => {
    const config = req.config

    if (Object.keys(config.crowi).length === 0) {
      return res.redirect('/installer')
    }

    return next()
  }
}
