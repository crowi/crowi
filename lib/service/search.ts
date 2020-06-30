import path from 'path'
import { Client as ES6Client } from 'es6'
import { Client as ES7Client } from 'es7'
import Debug from 'debug'
import { format } from 'date-fns'
import fs from 'fs'
import { EventEmitter } from 'events'
import Crowi from 'server/crowi'
import { Query, SearchWithBody, FunctionScoreQueryParams } from 'server/util/elasticsearch/query'
import { parseQuery } from 'server/service/query'
import { TYPES } from 'server/models/page'
import ElasticsearchClient from 'server/service/elasticsearch'

const debug = Debug('crowi:lib:search')

interface SearchOption {
  offset?: number
  limit?: number
  type?: typeof TYPES[number]
}

export default class Search {
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
  esPluginNames: string[] = []
  esUri: string
  crowi: Crowi
  searchEvent: EventEmitter
  node: string
  indexNames: { base: string; current: string }
  requestTimeout: number
  client: ElasticsearchClient

  constructor(crowi: Crowi, esUri: string) {
    this.esUri = esUri
    this.crowi = crowi
    this.searchEvent = crowi.event('Search')

    const uri = this.parseUri(this.esUri)
    const { node } = uri
    this.node = node
    this.indexNames = {
      base: uri.indexName,
      current: `${uri.indexName}-current`,
    }
    const requestTimeout = 5000
    this.requestTimeout = requestTimeout

    this.client = new ElasticsearchClient(new ES6Client({ node, requestTimeout }))
  }

  async waitES(retry = 10) {
    return new Promise((resolve) => {
      let count = 0
      const interval = setInterval(async () => {
        if (++count >= retry || (await this.client.ping())) {
          resolve()
          clearInterval(interval)
        }
      }, 5000)
    })
  }

  async checkESVersion() {
    try {
      const response = await this.client.nodes.info()
      const nodes = response.body
      if (!nodes.nodes) {
        throw new Error('no nodes info')
      }

      for (const [nodeName, { version, plugins }] of Object.entries(nodes.nodes)) {
        this.esNodeName = nodeName
        this.esNodeNames = [...this.esNodeNames, nodeName]
        this.esVersion = version
        this.esPluginNames = [...this.esPluginNames, ...plugins.map(({ name }) => name)]
      }
    } catch (error) {
      debug('es check version error:', error)
    }
  }

  isES7() {
    return this.esVersion.startsWith('7')
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

  async initialize() {
    const { node, requestTimeout } = this

    await this.waitES()

    await this.checkESVersion()

    if (this.isES7()) {
      this.client = new ElasticsearchClient(new ES7Client({ node, requestTimeout }))
    }

    await this.ensureAlias()

    this.registerUpdateEvent()
  }

  requireMappingFile() {
    const { resourceDir } = this.crowi

    let fileName = 'mappings.json'
    if ('analysis-kuromoji' in this.esPluginNames) {
      fileName = 'mappings-kuromoji.json'
    }
    if ('analysis-sudachi' in this.esPluginNames) {
      fileName = 'mappings-sudachi.json'
    }
    const dirName = this.isES7() ? 'es7' : 'es6'

    const filePath = path.join(resourceDir, 'search', dirName, fileName)
    return JSON.parse(fs.readFileSync(filePath).toString())
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
    const datetime = format(new Date(), 'yyyyMMddHHmmss')
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
    const deleteIndices = indices.filter((index) => index !== newIndexName)

    // for the first time, no old indices exists
    if (deleteIndices.length === 0) {
      return
    }

    await this.deleteIndices(deleteIndices)
  }

  async getIndices() {
    const response = await this.client.cat.indices({ format: 'json' })
    const indices = response.body
    return indices.map(({ index }) => index).filter((index) => index.startsWith(this.indexNames.base))
  }

  deleteIndices(indices) {
    return this.client.indices.delete({ index: indices })
  }

  async existsAlias() {
    const response = await this.client.indices.existsAlias({ name: this.indexNames.current })
    return response.body
  }

  async getAlias() {
    const existsAlias = await this.existsAlias()
    if (existsAlias) {
      const response = await this.client.cat.aliases({ name: this.indexNames.current, format: 'json' })
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

  getType() {
    return this.isES7() ? '_doc' : 'pages'
  }

  prepareBodyForUpdate(body, page, index = null) {
    if (!Array.isArray(body)) {
      throw new Error('Body must be an array.')
    }

    const command = {
      update: {
        _index: index || this.indexNames.current,
        _type: this.getType(),
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
        _type: this.getType(),
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
        _type: this.getType(),
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
    const response = await this.client.bulk({ body })
    return response.body
  }

  async updatePages(pages) {
    const body = []

    pages.map((page) => {
      this.prepareBodyForUpdate(body, page)
    })

    debug('updatePages(): Sending Request to ES', body)
    const response = await this.client.bulk({ body })
    return response.body
  }

  deletePages(pages) {
    const body = []

    pages.map((page) => {
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

    const bulkSend = async (body) => {
      try {
        const response = await this.client.bulk({
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
      await cursor.eachAsync(async (doc) => {
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
          await bulkSend(body)
          this.searchEvent.emit('addPageProgress', allPageCount, total, skipped)

          body = []
        }
      })
      // send all remaining data on body[]
      debug('Sending last body of bulk operation:', body.length)
      await bulkSend(body)
      this.searchEvent.emit('finishAddPage', allPageCount, total, skipped)
    } catch (e) {
      debug('Error wile iterating cursor.eacnAsync()', e)
      throw e
    }
  }

  async getBookmarkCountFactor() {
    const User = this.crowi.model('User')
    const count = await User.countDocuments({})
    return 10000 / (count || 1)
  }

  async getFunctionScoreQueryParams(): Promise<FunctionScoreQueryParams> {
    const factor = await this.getBookmarkCountFactor()
    return {
      fieldValueFactor: {
        field: 'bookmark_count',
        modifier: 'log1p',
        factor,
        missing: 0,
      },
      boostMode: 'sum',
    }
  }

  async search<T extends SearchWithBody>(query: T) {
    try {
      const response = await this.client.search(query)
      const { took, hits } = response.body
      return {
        meta: {
          took,
          total: typeof hits.total === 'number' ? hits.total : hits.total.value,
          results: hits.hits.length,
        },
        data: hits.hits.map(({ _id, _score, _source }) => ({ _id, _score, _source })),
      }
    } catch (err) {
      debug('Search error', err)
      throw err
    }
  }

  async searchKeyword<T extends { username: string }>(keyword: string, user: T, option: SearchOption = {}) {
    const { offset: from, limit: size, type } = option

    const query = Query.createBaseQuery({ index: this.indexNames.current, type: this.getType() })
      .appendPaging({ from, size })
      .appendSort({ _score: 'desc' })
      .filterPagesByType({ type })
      .filterPagesByUser({ username: user.username })
      .appendSearchQuery(parseQuery(keyword))
      .convertToFunctionScoreQuery(await this.getFunctionScoreQueryParams())
      .value()

    return this.search(query)
  }

  searchByPath(keyword, prefix) {
    // TODO path 名だけから検索
  }

  async searchKeywordUnderPath<T extends { username: string }>(keyword: string, path: string, user: T, option: SearchOption = {}) {
    const { offset: from, limit: size, type } = option

    const query = Query.createBaseQuery({ index: this.indexNames.current, type: this.getType() })
      .appendPaging({ from, size })
      .appendSort({ _score: 'desc' })
      .filterPagesByPath({ path })
      .filterPagesByType({ type })
      .filterPagesByUser({ username: user.username })
      .appendSearchQuery(parseQuery(keyword))
      .convertToFunctionScoreQuery(await this.getFunctionScoreQueryParams())
      .value()

    return this.search(query)
  }

  async syncPageCreated(page, user, bookmarkCount = 0) {
    debug('Search.syncPageCreated', page.path)

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
    debug('Search.syncPageUpdated', page.path)
    debug('Page:', page)
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
    debug('Search.syncPageDeleted', page.path)

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
