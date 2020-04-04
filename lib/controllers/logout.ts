import { Request, Response } from 'express'

export default () => {
  return {
    logout(req: Request, res: Response) {
      req.session.destroy(() => {})
      return res.redirect('/')
    },
  }
}
