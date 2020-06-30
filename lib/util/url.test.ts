import { getContinueUrl } from 'server/util/url'

describe('Url Util', function () {
  const req = (url) => ({ body: { continue: url } })

  it('should return internal URL', () => {
    expect(getContinueUrl(req('/test'))).toBe('/test')
    expect(getContinueUrl(req('/test/test'))).toBe('/test/test')
  })

  it('should return default value', () => {
    expect(getContinueUrl()).toBe('/')

    // Following examples are interpreted that it is equivalent to 'http://example.com'

    expect(getContinueUrl(req('http://example.com'))).toBe('/')

    expect(getContinueUrl(req(`//example.com`))).toBe('/')
    expect(getContinueUrl(req(`\\example.com`))).toBe('/')
    expect(getContinueUrl(req(`/\/example.com`))).toBe('/') // eslint-disable-line no-useless-escape
    expect(getContinueUrl(req(`\//example.com`))).toBe('/') // eslint-disable-line no-useless-escape
    expect(getContinueUrl(req(`\\//example.com`))).toBe('/') // eslint-disable-line no-useless-escape
    expect(getContinueUrl(req(`\/\/example.com`))).toBe('/') // eslint-disable-line no-useless-escape
    expect(getContinueUrl(req(`\\\\example.com`))).toBe('/')
  })
})
