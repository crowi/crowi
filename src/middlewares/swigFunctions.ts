import { Express, Request, Response } from 'express'
import Crowi from 'src/crowi'
import functions from 'src/util/swigFunctions'

export default (crowi: Crowi, app: Express) => {
  return (req: Request, res: Response, next) => {
    functions(crowi, app, req, res)
    next()
  }
}
