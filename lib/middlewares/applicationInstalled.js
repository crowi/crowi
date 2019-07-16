module.exports = () => {
  return (req, res, next) => {
    var config = req.config

    if (Object.keys(config.crowi).length === 1) {
      // app:url is set by process
      return res.redirect('/installer')
    }

    return next()
  }
}
