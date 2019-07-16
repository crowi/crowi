// this is for Installer
module.exports = () => {
  return (req, res, next) => {
    var config = req.config

    if (Object.keys(config.crowi).length !== 1) {
      req.flash('errorMessage', 'Application already installed.')
      return res.redirect('admin') // admin以外はadminRequiredで'/'にリダイレクトされる
    }

    return next()
  }
}
