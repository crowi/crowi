module.exports = () => {
  return (req, res, next) => {
    var config = req.config
    if (
      config.crowi['aws:region'] !== '' &&
      config.crowi['aws:bucket'] !== '' &&
      config.crowi['aws:accessKeyId'] !== '' &&
      config.crowi['aws:secretAccessKey'] !== ''
    ) {
      req.flash('globalError', 'AWS settings required to use this function. Please ask the administrator.')
      return res.redirect('/')
    }

    return next()
  }
}
