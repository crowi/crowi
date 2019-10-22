import path from 'path'
import { Client, ApiResponse } from 'es6'
import Debug from 'debug'
import moment from 'moment'
import fs from 'fs'
import { EventEmitter } from 'events'
import Crowi from 'server/crowi'
import {
  Plugin,
  NodesInfoResponse,
  CatIndicesResponse,
  IndicesExistsAliasResponse,
  CatAliasesResponse,
  BulkResponse,
  SearchResponse,
} from 'server/types/elasticsearch'

const debug = Debug('crowi:lib:search')

interface SearchOption {
  offset?: number
  limit?: number
  type?: string
}

export default class SearchClient {
  static DEFAULT_OFFSET = 0
  static DEFAULT_LIMIT = 50

  // In Elasticsearch RegExp, we don't need to used ^ and $.
  // Ref: https://www.elastic.co/guide/en/elasticsearch/reference/5.6/query-dsl-regexp-query.html#_standard_operators
  static queries = {
    PORTAL: {
      regexp: {
        'path.raw': '.*/',
      },
    },
    PUBLIC: {
      regexp: {
        'path.raw': '.*[^/]',
      },
    },
    USER: {
      prefix: {
        'path.raw': '/user/',
      },
    },
  }

  esNodeName = '-'
  esNodeNames: string[] = []
  esVersion = 'unknown'
  esPlugins: Plugin[] = []
  esUri: string
  crowi: Crowi
  searchEvent: EventEmitter
  indexNames: { base: string; current: string }
  client: Client

  constructor(crowi: Crowi, esUri: string) {
    this.esUri = esUri
    this.crowi = crowi
    this.searchEvent = crowi.event('Search')

    const uri = this.parseUri(this.esUri)
    const { node } = uri
    this.indexNames = {
      base: uri.indexName,
      current: `${uri.indexName}-current`,
    }

    this.client = new Client({ node, requestTimeout: 5000 })

    this.registerUpdateEvent()
  }

  requireMappingFile() {
    const { resourceDir } = this.crowi

    let fileName = path.join(resourceDir + 'search/mappings.json')
    if ('analysis-kuromoji' in this.esPlugins) {
      fileName = path.join(resourceDir + 'search/mappings-kuromoji.json')
    }
    if ('analysis-sudachi' in this.esPlugins) {
      fileName = path.join(resourceDir + 'search/mappings-sudachi.json')
    }
    return JSON.parse(fs.readFileSync(fileName).toString())
  }

  async checkESVersion() {
    try {
      const response: ApiResponse<NodesInfoResponse> = await this.client.nodes.info()
      const nodes = response.body
      if (!nodes.nodes) {
        throw new Error('no nodes info')
      }

      for (const [nodeName, { version, plugins }] of Object.entries<any>(nodes.nodes)) {
        this.esNodeName = nodeName
        this.esNodeNames.push(nodeName)
        this.esVersion = version
        this.esPlugins.push(plugins)
      }
    } catch (error) {
      debug('es check version error:', error)
    }
  }

  registerUpdateEvent() {
    const pageEvent = this.crowi.event('Page')
    pageEvent.on('create', this.syncPageCreated.bind(this))
    pageEvent.on('update', this.syncPageUpdated.bind(this))
    pageEvent.on('delete', this.syncPageDeleted.bind(this))

    const bookmarkEvent = this.crowi.event('Bookmark')
    bookmarkEvent.on('create', this.syncBookmarkChanged.bind(this))
    bookmarkEvent.on('delete', this.syncBookmarkChanged.bind(this))
  }

  shouldIndexed(page) {
    if (page.redirectTo !== null) {
      return false
    }

    // FIXME: use STATUS_DELETED
    // isDeleted() couldn't use here because of lean()
    if (page.status === 'deleted') {
      return false
    }

    return true
  }

  // BONSAI_URL is following format:
  // => https://{ID}:{PASSWORD}@{HOST}
  parseUri(uri) {
    if (!uri.startsWith('http')) {
      throw new Error('URL for Elasticsearch should starts with http/https')
    }

    const esUrl = new URL(uri)
    let indexName = 'crowi'
    const node = `${esUrl.protocol}//${esUrl.username && esUrl.password ? `${esUrl.username}:${esUrl.password}@` : ''}${esUrl.host}`
    if (esUrl.pathname !== '/') {
      indexName = esUrl.pathname.substring(1)
    }

    return { node, indexName }
  }

  createIndexName() {
    const datetime = moment().format('YYYYMMDDHHmmss')
    return `${this.indexNames.base}-${datetime}`
  }

  async createIndex(index) {
    await this.checkESVersion()
    const body = this.requireMappingFile()

    return this.client.indices.create({ index, body })
  }

  /**
   * Search operation: always access to `{indexName}-current`
   *
   * Build index (for the first time):
   *   1. Creating index with current timestamp: ex: {indexName}-20190625230435
   *   2. Add all pages to created index.
   *   3. Add alias to created index. alias {indexName}-current` to {index-name}-20190625230435
   *
   * Rebuild index:
   *   1. Creating index with current timestamp:
   *      ex.
   *      {indexName}-20190505220000 <-- existing index (current {indexName}-current)
   *      {indexName}-20190625230000 <-- created index.
   *   2. Add all pages to created index.
   *   3. Add alias to created index. And remove alias from old existing index.
   *      ex.
   *      {indexName}-20190505220000 <-- remove alias
   *      {indexName}-20190625230000 <-- `{indexName}-current`
   *   4. Delete old existing index. ({indexName}-20190505220000)
   *
   */
  async buildIndex() {
    const newIndexName = this.createIndexName()

    try {
      // creating index anyway.
      await this.createIndex(newIndexName)
      debug('Index created.')
    } catch (err) {
      debug('Error (while creating new index)', newIndexName, err)
      throw new Error('Error while creating index.')
    }

    try {
      await this.addAllPages(newIndexName)
      debug('Added all pages.')
    } catch (err) {
      debug('Error (while adding all pages)', err)
      throw new Error('Error while adding all pages.')
    }

    // remove `current` alias from old existing index, and add `current` to newIndexName index.
    const alias = await this.getAlias()
    const add = {
      index: newIndexName,
      alias: this.indexNames.current,
    }
    try {
      if (alias) {
        const remove = {
          index: '*',
          alias: alias.alias,
        }
        await this.updateAliases([{ add }, { remove }])
      } else {
        await this.updateAliases([{ add }])
      }
      debug('Updated aliases.')
    } catch (err) {
      debug('Error (while updating aliases)', err)
      throw new Error('Error while updating aliases.')
    }

    const indices = await this.getIndices()
    const deleteIndices = indices.filter(index => index !== newIndexName)

    // for the first time, no old indices exists
    if (deleteIndices.length === 0) {
      return
    }

    await this.deleteIndices(deleteIndices)
  }

  async getIndices() {
    const response: ApiResponse<CatIndicesResponse> = await this.client.cat.indices({ format: 'json' })
    const indices = response.body
    return indices.map(({ index }) => index).filter(index => index.startsWith(this.indexNames.base))
  }

  deleteIndices(indices) {
    return this.client.indices.delete({ index: indices })
  }

  async existsAlias() {
    const response: ApiResponse<IndicesExistsAliasResponse> = await this.client.indices.existsAlias({ name: this.indexNames.current })
    return response.body
  }

  async getAlias() {
    const existsAlias = await this.existsAlias()
    if (existsAlias) {
      const response: ApiResponse<CatAliasesResponse> = await this.client.cat.aliases({ name: this.indexNames.current, format: 'json' })
      const aliases = response.body
      if (aliases.length > 0) {
        return aliases[0]
      }
    }
  }

  async putAlias(index) {
    return this.client.indices.putAlias({ index, name: this.indexNames.current })
  }

  async ensureAlias() {
    const exists = await this.existsAlias()
    if (!exists) {
      const indices = await this.getIndices()
      if (indices.length > 0) {
        await this.putAlias(indices[0])
        return true
      }
    }
    return exists
  }

  async updateAliases(actions) {
    return this.client.indices.updateAliases({ body: { actions } })
  }

  prepareBodyForUpdate(body, page, index = null) {
    if (!Array.isArray(body)) {
      throw new Error('Body must be an array.')
    }

    const command = {
      update: {
        _index: index || this.indexNames.current,
        _type: 'pages',
        _id: page._id.toString(),
      },
    }

    const document = {
      doc: {
        path: page.path,
        body: page.revision.body,
        grant: page.grant,
        comment_count: page.commentCount,
        bookmark_count: page.bookmarkCount || 0,
        like_count: page.liker.length || 0,
        updated_at: page.updatedAt,
      },
      doc_as_upsert: true,
    }

    body.push(command)
    body.push(document)
  }

  prepareBodyForCreate(body, page, index = null) {
    if (!Array.isArray(body)) {
      throw new Error('Body must be an array.')
    }

    const command = {
      index: {
        _index: index || this.indexNames.current,
        _type: 'pages',
        _id: page._id.toString(),
      },
    }

    const bookmarkCount = page.bookmarkCount || 0
    const document = {
      path: page.path,
      body: page.revision.body,
      username: page.creator.username,
      grant: page.grant,
      comment_count: page.commentCount,
      bookmark_count: bookmarkCount,
      like_count: page.liker.length || 0,
      created_at: page.createdAt,
      updated_at: page.updatedAt,
    }

    body.push(command)
    body.push(document)
  }

  prepareBodyForDelete(body, page, index = null) {
    if (!Array.isArray(body)) {
      throw new Error('Body must be an array.')
    }

    const command = {
      delete: {
        _index: index || this.indexNames.current,
        _type: 'pages',
        _id: page._id.toString(),
      },
    }

    body.push(command)
  }

  async addPages(pages) {
    const Bookmark = this.crowi.model('Bookmark')
    const body = []

    for (const page of pages) {
      page.bookmarkCount = await Bookmark.countByPageId(page._id)
      this.prepareBodyForCreate(body, page)
    }

    debug('addPages(): Sending Request to ES', body)
    const response: ApiResponse<BulkResponse> = await this.client.bulk({ body })
    return response.body
  }

  async updatePages(pages) {
    const body = []

    pages.map(page => {
      this.prepareBodyForUpdate(body, page)
    })

    debug('updatePages(): Sending Request to ES', body)
    const response: ApiResponse<BulkResponse> = await this.client.bulk({ body })
    return response.body
  }

  deletePages(pages) {
    const body = []

    pages.map(page => {
      this.prepareBodyForDelete(body, page)
    })

    debug('deletePages(): Sending Request to ES', body)
    return this.client.bulk({
      body: body,
    })
  }

  async addAllPages(index) {
    const Page = this.crowi.model('Page')
    const allPageCount = await Page.allPageCount()
    const Bookmark = this.crowi.model('Bookmark')
    const cursor = Page.getStreamOfFindAll({ publicOnly: false })
    let body = []
    let sent = 0
    let skipped = 0
    let total = 0

    const bulkSend = async body => {
      try {
        const response: ApiResponse<BulkResponse> = await this.client.bulk({
          body,
          timeout: '1d',
        })
        const { items, errors, took } = response.body
        debug('addAllPages add anyway (items, errors, took): ', (items || []).length, errors, took, 'ms')
      } catch (err) {
        debug('addAllPages error on add anyway: ', err)
      }
    }

    try {
      await cursor.eachAsync(async doc => {
        if (!doc.creator || !doc.revision || !this.shouldIndexed(doc)) {
          // debug('Skipped', doc.path);
          skipped++
          return
        }
        total++

        const bookmarkCount = await Bookmark.countByPageId(doc._id)
        const page = { ...doc, bookmarkCount }
        this.prepareBodyForCreate(body, page, index)

        if (body.length >= 4000) {
          // send each 2000 docs. (body has 2 elements for each data)
          sent++
          debug('Sending request (seq, total, skipped)', sent, total, skipped)
          bulkSend(body)
          this.searchEvent.emit('addPageProgress', allPageCount, total, skipped)

          body = []
        }
      })
      // send all remaining data on body[]
      debug('Sending last body of bulk operation:', body.length)
      bulkSend(body)
      this.searchEvent.emit('finishAddPage', allPageCount, total, skipped)
    } catch (e) {
      debug('Error wile iterating cursor.eacnAsync()', e)
      throw e
    }
  }

  /**
   * search returning type:
   * {
   *   meta: { total: Integer, results: Integer},
   *   data: [ pages ...],
   * }
   */
  async search(query) {
    try {
      const response: ApiResponse<SearchResponse> = await this.client.search(query)
      const { took, hits } = response.body
      return {
        meta: {
          took,
          total: hits.total,
          results: hits.hits.length,
        },
        data: hits.hits.map(({ _id, _score, _source }) => ({ _id, _score, _source })),
      }
    } catch (err) {
      debug('Search error', err)
      throw err
    }
  }

  createSearchQuerySortedByUpdatedAt(option) {
    // getting path by default is almost for debug
    let fields = ['path', 'bookmark_count']
    if (option) {
      fields = option.fields || fields
    }

    // default is only id field, sorted by updated_at
    const query = {
      index: this.indexNames.current,
      type: 'pages',
      body: {
        sort: [{ updated_at: { order: 'desc' } }],
        query: {}, // query
        _source: fields,
      },
    }
    this.appendResultSize(query)

    return query
  }

  createSearchQuerySortedByScore(option?) {
    let fields = ['path', 'bookmark_count']
    if (option) {
      fields = option.fields || fields
    }

    // sort by score
    const query = {
      index: this.indexNames.current,
      type: 'pages',
      body: {
        sort: [{ _score: { order: 'desc' } }],
        query: {}, // query
        _source: fields,
      },
    }
    this.appendResultSize(query)

    return query
  }

  appendResultSize(query, from: number = SearchClient.DEFAULT_OFFSET, size: number = SearchClient.DEFAULT_LIMIT) {
    query.from = from
    query.size = size
  }

  initializeBoolQuery(query) {
    // query is created by createSearchQuerySortedByScore() or createSearchQuerySortedByUpdatedAt()
    if (!query.body.query.bool) {
      query.body.query.bool = {}
    }

    const isInitialized = query => !!query && Array.isArray(query)

    if (!isInitialized(query.body.query.bool.filter)) {
      query.body.query.bool.filter = []
    }
    if (!isInitialized(query.body.query.bool.must)) {
      query.body.query.bool.must = []
    }
    if (!isInitialized(query.body.query.bool.must_not)) {
      query.body.query.bool.must_not = []
    }
    return query
  }

  appendCriteriaForKeywordContains(query, keyword) {
    query = this.initializeBoolQuery(query)

    const appendMultiMatchQuery = function(query, type, keywords) {
      let target
      let operator = 'and'
      switch (type) {
        case 'not_match':
          target = query.body.query.bool.must_not
          operator = 'or'
          break
        case 'match':
        default:
          target = query.body.query.bool.must
      }

      target.push({
        multi_match: {
          query: keywords.join(' '),
          // TODO: By user's i18n setting, change boost or search target fields
          fields: ['path.ja^2', 'body.ja', 'path.en^1.2', 'body.en'],
          operator: operator,
        },
      })

      return query
    }

    const parsedKeywords = this.getParsedKeywords(keyword)

    if (parsedKeywords.match.length > 0) {
      query = appendMultiMatchQuery(query, 'match', parsedKeywords.match)
    }

    if (parsedKeywords.not_match.length > 0) {
      query = appendMultiMatchQuery(query, 'not_match', parsedKeywords.not_match)
    }

    if (parsedKeywords.phrase.length > 0) {
      const phraseQueries: any = []
      parsedKeywords.phrase.forEach(function(phrase) {
        phraseQueries.push({
          multi_match: {
            query: phrase, // each phrase is quoteted words
            type: 'phrase',
            fields: [
              // Not use "*.ja" fields here, because we want to analyze (parse) search words
              'path.raw^2',
              'body',
            ],
          },
        })
      })

      query.body.query.bool.must.push(phraseQueries)
    }

    if (parsedKeywords.not_phrase.length > 0) {
      const notPhraseQueries: any = []
      parsedKeywords.not_phrase.forEach(function(phrase) {
        notPhraseQueries.push({
          multi_match: {
            query: phrase, // each phrase is quoteted words
            type: 'phrase',
            fields: [
              // Not use "*.ja" fields here, because we want to analyze (parse) search words
              'path.raw^2',
              'body',
            ],
          },
        })
      })

      query.body.query.bool.must_not.push(notPhraseQueries)
    }
  }

  appendCriteriaForPathFilter(query, path) {
    query = this.initializeBoolQuery(query)

    if (path.match(/\/$/)) {
      path = path.substr(0, path.length - 1)
    }
    query.body.query.bool.filter.push({
      wildcard: {
        'path.raw': path + '/*',
      },
    })
  }

  filterPortalPages(query) {
    query = this.initializeBoolQuery(query)

    query.body.query.bool.must_not.push(SearchClient.queries.USER)
    query.body.query.bool.filter.push(SearchClient.queries.PORTAL)
  }

  filterPublicPages(query) {
    query = this.initializeBoolQuery(query)

    query.body.query.bool.must_not.push(SearchClient.queries.USER)
    query.body.query.bool.filter.push(SearchClient.queries.PUBLIC)
  }

  filterUserPages(query) {
    query = this.initializeBoolQuery(query)

    query.body.query.bool.filter.push(SearchClient.queries.USER)
  }

  filterPagesByType(query, type) {
    const Page = this.crowi.model('Page')

    switch (type) {
      case Page.TYPE_PORTAL:
        return this.filterPortalPages(query)
      case Page.TYPE_PUBLIC:
        return this.filterPublicPages(query)
      case Page.TYPE_USER:
        return this.filterUserPages(query)
      default:
        return query
    }
  }

  filterPagesByUser(query, user) {
    const Page = this.crowi.model('Page')

    query = this.initializeBoolQuery(query)

    query.body.query.bool.must_not.push({
      bool: {
        must_not: { match: { username: user.username } },
        should: [{ match: { grant: Page.GRANT_RESTRICTED } }, { match: { grant: Page.GRANT_SPECIFIED } }, { match: { grant: Page.GRANT_OWNER } }],
      },
    })
  }

  async appendFunctionScore(query) {
    const User = this.crowi.model('User')
    const count = (await User.countDocuments({})) || 1
    // newScore = oldScore + log(1 + factor * 'bookmark_count')
    query.body.query = {
      function_score: {
        query: { ...query.body.query },
        field_value_factor: {
          field: 'bookmark_count',
          modifier: 'log1p',
          factor: 10000 / count,
          missing: 0,
        },
        boost_mode: 'sum',
      },
    }
  }

  async searchKeyword(keyword, user = {}, option: SearchOption = {}) {
    const from = option.offset
    const size = option.limit
    const type = option.type
    const query = this.createSearchQuerySortedByScore()
    this.appendCriteriaForKeywordContains(query, keyword)

    this.filterPagesByType(query, type)
    this.filterPagesByUser(query, user)

    this.appendResultSize(query, from, size)

    await this.appendFunctionScore(query)

    // @ts-ignore
    const bool = query.body.query.function_score.query.bool

    debug('searching ...', keyword, type)
    debug('filter', bool.filter)
    debug('must', bool.must)
    debug('must_not', bool.must_not)

    return this.search(query)
  }

  searchByPath(keyword, prefix) {
    // TODO path 名だけから検索
  }

  async searchKeywordUnderPath(keyword, path, user = {}, option: SearchOption = {}) {
    const from = option.offset
    const size = option.limit
    const type = option.type
    const query = this.createSearchQuerySortedByScore()
    this.appendCriteriaForKeywordContains(query, keyword)
    this.appendCriteriaForPathFilter(query, path)

    this.filterPagesByType(query, type)
    this.filterPagesByUser(query, user)

    this.appendResultSize(query, from, size)

    await this.appendFunctionScore(query)

    return this.search(query)
  }

  getParsedKeywords(keyword) {
    const matchWords: any = []
    const notMatchWords: any = []
    const phraseWords: any = []
    const notPhraseWords: any = []

    keyword.trim()
    keyword = keyword.replace(/\s+/g, ' ')

    // First: Parse phrase keywords
    const phraseRegExp = new RegExp(/(-?"[^"]+")/g)
    const phrases = keyword.match(phraseRegExp)

    if (phrases !== null) {
      keyword = keyword.replace(phraseRegExp, '')

      phrases.forEach(function(phrase) {
        phrase.trim()
        if (phrase.match(/^-/)) {
          notPhraseWords.push(phrase.replace(/^-/, ''))
        } else {
          phraseWords.push(phrase)
        }
      })
    }

    // Second: Parse other keywords (include minus keywords)
    keyword.split(' ').forEach(function(word) {
      if (word === '') {
        return
      }

      if (word.match(/^-(.+)$/)) {
        notMatchWords.push(RegExp.$1)
      } else {
        matchWords.push(word)
      }
    })

    return {
      match: matchWords,
      not_match: notMatchWords,
      phrase: phraseWords,
      not_phrase: notPhraseWords,
    }
  }

  async syncPageCreated(page, user, bookmarkCount = 0) {
    debug('SearchClient.syncPageCreated', page.path)

    if (!this.shouldIndexed(page)) {
      return
    }

    page.bookmarkCount = bookmarkCount
    try {
      const res = await this.addPages([page])
      debug('ES Response', res)
    } catch (err) {
      debug('ES Error', err)
    }
  }

  async syncPageUpdated(page, user, bookmarkCount = 0) {
    debug('SearchClient.syncPageUpdated', page.path)
    debug('Page:', page)
    // TODO delete
    if (!this.shouldIndexed(page)) {
      try {
        const res = await this.deletePages([page])
        debug('deletePages: ES Response', res)
      } catch (err) {
        debug('deletePages: ES Error', err)
      }

      return
    }

    page.bookmarkCount = bookmarkCount
    try {
      const res = await this.updatePages([page])
      debug('ES Response', res)
    } catch (err) {
      debug('ES Error', err)
    }
  }

  async syncPageDeleted(page, user) {
    debug('SearchClient.syncPageDeleted', page.path)

    try {
      const res = await this.deletePages([page])
      debug('deletePages: ES Response', res)
    } catch (err) {
      debug('deletePages: ES Error', err)
    }
  }

  async syncBookmarkChanged(pageId) {
    const Page = this.crowi.model('Page')
    const Bookmark = this.crowi.model('Bookmark')
    const [page, bookmarkCount] = await Promise.all([Page.findPageById(pageId), Bookmark.countByPageId(pageId)])

    // @ts-ignore
    page.bookmarkCount = bookmarkCount
    try {
      const res = await this.updatePages([page])
      debug('ES Response', res)
    } catch (err) {
      debug('ES Error', err)
    }
  }
}
