module.exports = () => {
  return (req, res, next) => {
    if (req.user && '_id' in req.user) {
      if (req.user.admin) {
        next()
        return
      }
      return res.redirect('/')
    }
    return res.redirect('/login')
  }
}
