module.exports = (crowi, app) => {
  return async function(req, res, next) {
    try {
      const Attachment = crowi.model('Attachment')
      const Share = crowi.model('Share')
      const attachment = await Attachment.findById(req.params.id)
      const { uuid, secretKeyword } = await Share.findShareByPageId(attachment.page, { status: Share.STATUS_ACTIVE })
      const { shareIds = [], secretKeywords = {} } = req.session
      const isNoExistKeyword = !secretKeyword
      const hasCorrectKeyword = secretKeywords[uuid] === secretKeyword
      const isAccessedSharedPage = shareIds.includes(uuid)
      const hasAccessRight = (isNoExistKeyword || hasCorrectKeyword) && isAccessedSharedPage
      if (hasAccessRight) {
        return next()
      }
    } catch (err) {
      // share url not found, but its okay
      // debug(err)
    }
    return exports.loginRequired(crowi, app)(req, res, next)
  }
}
