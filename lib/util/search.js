/**
 * Search
 */

const path = require('path')
const elasticsearch = require('elasticsearch')
const debug = require('debug')('crowi:lib:search')
const moment = require('moment')

function SearchClient(crowi, esUri) {
  this.DEFAULT_OFFSET = 0
  this.DEFAULT_LIMIT = 50

  this.esNodeName = '-'
  this.esNodeNames = []
  this.esVersion = 'unknown'
  this.esVersions = []
  this.esPlugin = []
  this.esPlugins = []
  this.esUri = esUri
  this.crowi = crowi
  this.searchEvent = crowi.event('search')

  // In Elasticsearch RegExp, we don't need to used ^ and $.
  // Ref: https://www.elastic.co/guide/en/elasticsearch/reference/5.6/query-dsl-regexp-query.html#_standard_operators
  this.queries = {
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

  const uri = this.parseUri(this.esUri)
  this.host = uri.host
  this.indexNames = {
    base: uri.indexName,
    current: `${uri.indexName}-current`,
  }

  this.client = new elasticsearch.Client({
    host: this.host,
    requestTimeout: 5000,
    // log: 'debug',
  })

  this.registerUpdateEvent()
}

SearchClient.prototype.selectMappingFile = function() {
  if ('analysis-kuromoji' in this.esPlugins) {
    return 'mappings-kuromoji.json'
  }
  if ('analysis-sudachi' in this.esPlugins) {
    return 'mappings-sudachi.json'
  }
  return 'mappings.json'
}

SearchClient.prototype.checkESVersion = async function() {
  try {
    const nodes = await this.client.nodes.info()
    if (!nodes._nodes || !nodes.nodes) {
      throw new Error('no nodes info')
    }

    for (const [nodeName, nodeInfo] of Object.entries(nodes.nodes)) {
      this.esNodeName = nodeName
      this.esNodeNames.push(nodeName)
      this.esVersion = nodeInfo.version
      this.esVersions.push(nodeInfo.version)
      this.esPlugin = nodeInfo.plugins
      this.esPlugins.push(nodeInfo.plugins)
    }
  } catch (error) {
    debug('es check version error:', error)
  }
}

SearchClient.prototype.registerUpdateEvent = function() {
  const pageEvent = this.crowi.event('page')
  pageEvent.on('create', this.syncPageCreated.bind(this))
  pageEvent.on('update', this.syncPageUpdated.bind(this))
  pageEvent.on('delete', this.syncPageDeleted.bind(this))

  const bookmarkEvent = this.crowi.event('bookmark')
  bookmarkEvent.on('create', this.syncBookmarkChanged.bind(this))
  bookmarkEvent.on('delete', this.syncBookmarkChanged.bind(this))
}

SearchClient.prototype.shouldIndexed = function(page) {
  // FIXME: Magic Number
  if (page.grant !== 1) {
    return false
  }

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
SearchClient.prototype.parseUri = function(uri) {
  var indexName = 'crowi'
  var host = uri
  let m
  if ((m = uri.match(/^(https?:\/\/[^/]+)\/(.+)$/))) {
    host = m[1]
    indexName = m[2]
  }

  return {
    host,
    indexName,
  }
}

SearchClient.prototype.createIndexName = function() {
  const datetime = moment().format('YYYYMMDDHHmmss')
  return `${this.indexNames.base}-${datetime}`
}

SearchClient.prototype.createIndex = async function(index) {
  await this.checkESVersion()
  const mappingDir = this.crowi.resourceDir + 'search'
  const mappingFile = path.join(mappingDir, this.selectMappingFile())
  const body = require(mappingFile)

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
SearchClient.prototype.buildIndex = async function() {
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
  if (alias) {
    const remove = {
      index: alias.index,
      alias: alias.alias,
    }
    await this.updateAliases({ add, remove })
  } else {
    await this.updateAliases({ add })
  }

  const indices = await this.getIndices()
  const deleteIndices = indices.filter(index => index !== newIndexName)

  // for the first time, no old indices exists
  if (deleteIndices.length === 0) {
    return
  }

  await this.deleteIndices(deleteIndices)
}

SearchClient.prototype.getIndices = async function() {
  const indices = await this.client.cat.indices({ format: 'json' })
  return indices.map(({ index }) => index).filter(index => index.startsWith(this.indexNames.base))
}

SearchClient.prototype.deleteIndices = function(indices) {
  return this.client.indices.delete({ index: indices })
}

SearchClient.prototype.existsAlias = function() {
  return this.client.indices.existsAlias({ name: this.indexNames.current })
}

SearchClient.prototype.getAlias = function() {
  const existsAlias = this.existsAlias()
  if (existsAlias) {
    const aliases = this.client.cat.aliases({ name: this.indexNames.current, format: 'json' })
    if (aliases.length > 0) {
      return aliases[0]
    }
  }
  return null
}

SearchClient.prototype.putAlias = async function(index) {
  return this.client.indices.putAlias({ index, name: this.indexNames.current })
}

SearchClient.prototype.ensureAlias = async function() {
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

SearchClient.prototype.updateAliases = async function(actions) {
  return this.client.indices.updateAliases({ body: { actions } })
}

SearchClient.prototype.prepareBodyForUpdate = function(body, page, index = null) {
  if (!Array.isArray(body)) {
    throw new Error('Body must be an array.')
  }

  var command = {
    update: {
      _index: index || this.indexNames.current,
      _type: 'pages',
      _id: page._id.toString(),
    },
  }

  var document = {
    doc: {
      path: page.path,
      body: page.revision.body,
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

SearchClient.prototype.prepareBodyForCreate = function(body, page, index = null) {
  if (!Array.isArray(body)) {
    throw new Error('Body must be an array.')
  }

  var command = {
    index: {
      _index: index || this.indexNames.current,
      _type: 'pages',
      _id: page._id.toString(),
    },
  }

  const bookmarkCount = page.bookmarkCount || 0
  var document = {
    path: page.path,
    body: page.revision.body,
    username: page.creator.username,
    comment_count: page.commentCount,
    bookmark_count: bookmarkCount,
    like_count: page.liker.length || 0,
    created_at: page.createdAt,
    updated_at: page.updatedAt,
  }

  body.push(command)
  body.push(document)
}

SearchClient.prototype.prepareBodyForDelete = function(body, page, index = null) {
  if (!Array.isArray(body)) {
    throw new Error('Body must be an array.')
  }

  var command = {
    delete: {
      _index: index || this.indexNames.current,
      _type: 'pages',
      _id: page._id.toString(),
    },
  }

  body.push(command)
}

SearchClient.prototype.addPages = async function(pages) {
  const Bookmark = this.crowi.model('Bookmark')
  const body = []

  for (const page of pages) {
    page.bookmarkCount = await Bookmark.countByPageId(page._id)
    this.prepareBodyForCreate(body, page)
  }

  debug('addPages(): Sending Request to ES', body)
  return this.client.bulk({
    body: body,
  })
}

SearchClient.prototype.updatePages = function(pages) {
  var self = this
  var body = []

  pages.map(function(page) {
    self.prepareBodyForUpdate(body, page)
  })

  debug('updatePages(): Sending Request to ES', body)
  return this.client.bulk({
    body: body,
  })
}

SearchClient.prototype.deletePages = function(pages) {
  var self = this
  var body = []

  pages.map(function(page) {
    self.prepareBodyForDelete(body, page)
  })

  debug('deletePages(): Sending Request to ES', body)
  return this.client.bulk({
    body: body,
  })
}

SearchClient.prototype.addAllPages = async function(index) {
  const self = this
  const Page = this.crowi.model('Page')
  const allPageCount = await Page.allPageCount()
  const Bookmark = this.crowi.model('Bookmark')
  const cursor = Page.getStreamOfFindAll()
  let body = []
  let sent = 0
  let skipped = 0
  let total = 0

  return new Promise((resolve, reject) => {
    const bulkSend = body => {
      self.client
        .bulk({
          body: body,
          requestTimeout: Infinity,
        })
        .then(res => {
          debug('addAllPages add anyway (items, errors, took): ', (res.items || []).length, res.errors, res.took, 'ms')
        })
        .catch(err => {
          debug('addAllPages error on add anyway: ', err)
        })
    }

    cursor
      .eachAsync(async doc => {
        if (!doc.creator || !doc.revision || !self.shouldIndexed(doc)) {
          // debug('Skipped', doc.path);
          skipped++
          return
        }
        total++

        const bookmarkCount = await Bookmark.countByPageId(doc._id)
        const page = { ...doc, bookmarkCount }
        self.prepareBodyForCreate(body, page, index)

        if (body.length >= 4000) {
          // send each 2000 docs. (body has 2 elements for each data)
          sent++
          debug('Sending request (seq, total, skipped)', sent, total, skipped)
          bulkSend(body)
          this.searchEvent.emit('addPageProgress', allPageCount, total, skipped)

          body = []
        }
      })
      .then(() => {
        // send all remaining data on body[]
        debug('Sending last body of bulk operation:', body.length)
        bulkSend(body)
        this.searchEvent.emit('finishAddPage', allPageCount, total, skipped)

        resolve()
      })
      .catch(e => {
        debug('Error wile iterating cursor.eacnAsync()', e)
        reject(e)
      })
  })
}

/**
 * search returning type:
 * {
 *   meta: { total: Integer, results: Integer},
 *   data: [ pages ...],
 * }
 */
SearchClient.prototype.search = function(query) {
  var self = this

  return new Promise(function(resolve, reject) {
    self.client
      .search(query)
      .then(function(data) {
        var result = {
          meta: {
            took: data.took,
            total: data.hits.total,
            results: data.hits.hits.length,
          },
          data: data.hits.hits.map(function(elm) {
            return { _id: elm._id, _score: elm._score, _source: elm._source }
          }),
        }

        resolve(result)
      })
      .catch(function(err) {
        debug('Search error', err)
        reject(err)
      })
  })
}

SearchClient.prototype.createSearchQuerySortedByUpdatedAt = function(option) {
  // getting path by default is almost for debug
  var fields = ['path', 'bookmark_count']
  if (option) {
    fields = option.fields || fields
  }

  // default is only id field, sorted by updated_at
  var query = {
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

SearchClient.prototype.createSearchQuerySortedByScore = function(option) {
  var fields = ['path', 'bookmark_count']
  if (option) {
    fields = option.fields || fields
  }

  // sort by score
  var query = {
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

SearchClient.prototype.appendResultSize = function(query, from, size) {
  query.from = from || this.DEFAULT_OFFSET
  query.size = size || this.DEFAULT_LIMIT
}

SearchClient.prototype.initializeBoolQuery = function(query) {
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

SearchClient.prototype.appendCriteriaForKeywordContains = function(query, keyword) {
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

  var parsedKeywords = this.getParsedKeywords(keyword)

  if (parsedKeywords.match.length > 0) {
    query = appendMultiMatchQuery(query, 'match', parsedKeywords.match)
  }

  if (parsedKeywords.not_match.length > 0) {
    query = appendMultiMatchQuery(query, 'not_match', parsedKeywords.not_match)
  }

  if (parsedKeywords.phrase.length > 0) {
    var phraseQueries = []
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
    var notPhraseQueries = []
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

SearchClient.prototype.appendCriteriaForPathFilter = function(query, path) {
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

SearchClient.prototype.filterPortalPages = function(query) {
  query = this.initializeBoolQuery(query)

  query.body.query.bool.must_not.push(this.queries.USER)
  query.body.query.bool.filter.push(this.queries.PORTAL)
}

SearchClient.prototype.filterPublicPages = function(query) {
  query = this.initializeBoolQuery(query)

  query.body.query.bool.must_not.push(this.queries.USER)
  query.body.query.bool.filter.push(this.queries.PUBLIC)
}

SearchClient.prototype.filterUserPages = function(query) {
  query = this.initializeBoolQuery(query)

  query.body.query.bool.filter.push(this.queries.USER)
}

SearchClient.prototype.filterPagesByType = function(query, type) {
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

SearchClient.prototype.appendFunctionScore = function(query) {
  const User = this.crowi.model('User')
  const count = User.count({}) || 1
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

SearchClient.prototype.searchKeyword = function(keyword, option) {
  const from = option.offset || null
  const size = option.limit || null
  const type = option.type || null
  const query = this.createSearchQuerySortedByScore()
  this.appendCriteriaForKeywordContains(query, keyword)

  this.filterPagesByType(query, type)

  this.appendResultSize(query, from, size)

  this.appendFunctionScore(query)

  const bool = query.body.query.function_score.query.bool

  debug('searching ...', keyword, type)
  debug('filter', bool.filter)
  debug('must', bool.must)
  debug('must_not', bool.must_not)

  return this.search(query)
}

SearchClient.prototype.searchByPath = function(keyword, prefix) {
  // TODO path 名だけから検索
}

SearchClient.prototype.searchKeywordUnderPath = function(keyword, path, option) {
  const from = option.offset || null
  const size = option.limit || null
  const type = option.type || null
  const query = this.createSearchQuerySortedByScore()
  this.appendCriteriaForKeywordContains(query, keyword)
  this.appendCriteriaForPathFilter(query, path)

  this.filterPagesByType(query, type)

  this.appendResultSize(query, from, size)

  this.appendFunctionScore(query)

  return this.search(query)
}

SearchClient.prototype.getParsedKeywords = function(keyword) {
  var matchWords = []
  var notMatchWords = []
  var phraseWords = []
  var notPhraseWords = []

  keyword.trim()
  keyword = keyword.replace(/\s+/g, ' ')

  // First: Parse phrase keywords
  var phraseRegExp = new RegExp(/(-?"[^"]+")/g)
  var phrases = keyword.match(phraseRegExp)

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

SearchClient.prototype.syncPageCreated = function(page, user, bookmarkCount = 0) {
  debug('SearchClient.syncPageCreated', page.path)

  if (!this.shouldIndexed(page)) {
    return
  }

  page.bookmarkCount = bookmarkCount
  this.addPages([page])
    .then(function(res) {
      debug('ES Response', res)
    })
    .catch(function(err) {
      debug('ES Error', err)
    })
}

SearchClient.prototype.syncPageUpdated = function(page, user, bookmarkCount = 0) {
  debug('SearchClient.syncPageUpdated', page.path)
  // TODO delete
  if (!this.shouldIndexed(page)) {
    this.deletePages([page])
      .then(function(res) {
        debug('deletePages: ES Response', res)
      })
      .catch(function(err) {
        debug('deletePages:ES Error', err)
      })

    return
  }

  page.bookmarkCount = bookmarkCount
  this.updatePages([page])
    .then(function(res) {
      debug('ES Response', res)
    })
    .catch(function(err) {
      debug('ES Error', err)
    })
}

SearchClient.prototype.syncPageDeleted = function(page, user) {
  debug('SearchClient.syncPageDeleted', page.path)

  this.deletePages([page])
    .then(function(res) {
      debug('deletePages: ES Response', res)
    })
    .catch(function(err) {
      debug('deletePages:ES Error', err)
    })
}

SearchClient.prototype.syncBookmarkChanged = async function(pageId) {
  const Page = this.crowi.model('Page')
  const Bookmark = this.crowi.model('Bookmark')
  const [page, bookmarkCount] = await Promise.all([Page.findPageById(pageId), Bookmark.countByPageId(pageId)])

  page.bookmarkCount = bookmarkCount
  this.updatePages([page])
    .then(res => debug('ES Response', res))
    .catch(err => debug('ES Error', err))
}

module.exports = SearchClient
