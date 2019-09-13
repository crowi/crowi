export default () => {
  return (req, res, next) => {
    var config = req.config
    if (
      config.crowi['upload:aws:region'] !== '' &&
      config.crowi['upload:aws:bucket'] !== '' &&
      config.crowi['upload:aws:accessKeyId'] !== '' &&
      config.crowi['upload:aws:secretAccessKey'] !== ''
    ) {
      req.flash('globalError', 'AWS settings required to use this function. Please ask the administrator.')
      return res.redirect('/')
    }

    return next()
  }
}
