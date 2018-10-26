var chai = require('chai')
var expect = chai.expect
var sinon = require('sinon')
var sinonChai = require('sinon-chai')
var utils = require('../utils.js')
chai.use(sinonChai)

const path = require('path')

describe('Search client', () => {
  const crowi = new (require(ROOT_DIR + '/lib/crowi'))(ROOT_DIR, process.env)
  const searcherUri = 'http://127.0.0.1:19200/crowi'
  const searcher = new (require(path.join(crowi.libDir, 'util', 'search')))(crowi, searcherUri)

  describe('SearchClient.parseUri', () => {
    test('should return host and indexName', () => {
      let res

      res = searcher.parseUri('http://127.0.0.1:19200/crowi')
      expect(res.host).to.be.equal('http://127.0.0.1:19200')
      expect(res.indexName).to.be.equal('crowi')

      res = searcher.parseUri('https://user:pass@example.com:9200/crowi_search')
      expect(res.host).to.be.equal('https://user:pass@example.com:9200')
      expect(res.indexName).to.be.equal('crowi_search')
    })
  })
})
