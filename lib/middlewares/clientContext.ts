export default () => {
  return (req, res, next) => {
    const { _id = '', name, username = '' } = req.user || {}
    const id = _id.toString()
    const { language: lang = '' } = req.i18n || {}
    res.locals.user_context = { user: { id, name, username }, config: { lang } }
    next()
  }
}
