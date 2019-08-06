export default () => {
  return {
    logout(req, res) {
      req.session.destroy()
      return res.redirect('/')
    },
  }
}
