import { Request, Response } from 'express'

export default () => {
  return (req: Request, res: Response, next) => {
    if (req.user?.admin) {
      return next()
    }
    if (req.user) {
      return res.redirect('/')
    }
    return res.redirect('/login')
  }
}
