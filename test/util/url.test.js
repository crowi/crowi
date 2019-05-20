const chai = require('chai')
const expect = chai.expect
const sinon = require('sinon')
const sinonChai = require('sinon-chai')
const utils = require('../utils.js')
chai.use(sinonChai)

describe('Url Util', function() {
  const { getContinueUrl } = require(ROOT_DIR + '/lib/util/url')
  const req = url => ({ body: { continue: url } })

  it('should return internal URL', () => {
    expect(getContinueUrl(req('/test'))).to.be.equal('/test')
    expect(getContinueUrl(req('/test/test'))).to.be.equal('/test/test')
  })

  it('should return default value', () => {
    expect(getContinueUrl()).to.be.equal('/')

    // Following examples are interpreted that it is equivalent to 'http://example.com'

    expect(getContinueUrl(req('http://example.com'))).to.be.equal('/')

    expect(getContinueUrl(req(`//example.com`))).to.be.equal('/')
    expect(getContinueUrl(req(`\\example.com`))).to.be.equal('/')
    expect(getContinueUrl(req(`/\/example.com`))).to.be.equal('/') // eslint-disable-line no-useless-escape
    expect(getContinueUrl(req(`\//example.com`))).to.be.equal('/') // eslint-disable-line no-useless-escape
    expect(getContinueUrl(req(`\\//example.com`))).to.be.equal('/') // eslint-disable-line no-useless-escape
    expect(getContinueUrl(req(`\/\/example.com`))).to.be.equal('/') // eslint-disable-line no-useless-escape
    expect(getContinueUrl(req(`\\\\example.com`))).to.be.equal('/')
  })
})
