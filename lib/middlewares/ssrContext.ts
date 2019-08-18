export default () => {
  return (req, res, next) => {
    res.locals.ssr_id = 0
    res.locals.ssr_context = []
    next()
  }
}
