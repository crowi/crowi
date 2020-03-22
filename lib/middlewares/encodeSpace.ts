import { encodeSpace } from '../utils/path'

export default () => {
  return (req, res, next) => {
    const path = decodeURIComponent(req.originalUrl || '')
    const encodedPath = encodeSpace(path)

    if (path !== encodedPath) {
      return res.redirect(encodedPath)
    }

    return next()
  }
}
