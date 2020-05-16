import Crowi from 'server/crowi'
import { ROOT_DIR } from 'server/test/setup'
import Searcher from 'server/service/search'

describe('Search client', () => {
  const crowi = new Crowi(ROOT_DIR, process.env)
  const searcherUri = 'http://127.0.0.1:19200/crowi'
  const searcher = new Searcher(crowi, searcherUri)

  describe('Search.parseUri', () => {
    test('should return node and indexName', () => {
      let res

      res = searcher.parseUri('http://127.0.0.1:19200/crowi')
      expect(res.node).toBe('http://127.0.0.1:19200')
      expect(res.indexName).toBe('crowi')

      res = searcher.parseUri('https://user:pass@example.com:9200/crowi_search')
      expect(res.node).toBe('https://user:pass@example.com:9200')
      expect(res.indexName).toBe('crowi_search')

      res = searcher.parseUri('http://127.0.0.1:19200')
      expect(res.node).toBe('http://127.0.0.1:19200')
      expect(res.indexName).toBe('crowi')

      // format of docker
      res = searcher.parseUri('http://elasticsearch:9200/')
      expect(res.node).toBe('http://elasticsearch:9200')
      expect(res.indexName).toBe('crowi')
    })
  })

  describe('Search.parseUri error on not start with http', () => {
    test('should throw error', () => {
      expect(() => searcher.parseUri('elasticsearch:9200/')).toThrow(/URL for Elasticsearch should starts with http/)
    })
  })
})
