export const getContinueUrl = (req: any = {}) => {
  const { body = {}, query = {} } = req
  const url = body.continue || query.continue
  const continueUrl = /^(?![/\\]{2,})\/.*$/.test(url) ? url : '/'

  return continueUrl
}
