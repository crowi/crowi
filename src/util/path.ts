export const encodeSpace = (s) => {
  return s.replace(/ /g, '+')
}

export const decodeSpace = (s) => {
  return s.replace(/\+/g, ' ')
}
