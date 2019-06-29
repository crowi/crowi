module.exports = {
  encodeSpace(s) {
    return s.replace(/ /g, '+')
  },
  decodeSpace(s) {
    return s.replace(/\+/g, ' ')
  },
}
