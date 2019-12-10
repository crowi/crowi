import { Request, Response } from 'express'
import Crowi from 'server/crowi'
import ApiResponse from '../utils/apiResponse'

export default (crowi: Crowi) => {
  // const debug = Debug('crowi:routes:shareAccess')
  const ShareAccess = crowi.model('ShareAccess')
  const actions = {} as any

  const api = (actions.api = {} as any)

  api.list = async (req: Request, res: Response) => {
    let { page = 1, limit = 50 } = req.query
    page = parseInt(page)
    limit = parseInt(limit)
    const options = { page, limit }
    try {
      const accessData = await ShareAccess.findAccesses({}, options)
      const result = { shareAccess: accessData }
      return res.json(ApiResponse.success(result))
    } catch (err) {
      return res.json(ApiResponse.error(err))
    }
  }

  return actions
}
