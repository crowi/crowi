/**
 * Search
 */

var elasticsearch = require('elasticsearch')
var debug = require('debug')('crowi:lib:search')

function SearchClient(crowi, esUri) {
  this.DEFAULT_OFFSET = 0
  this.DEFAULT_LIMIT = 50

  this.esUri = esUri
  this.crowi = crowi

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

  var uri = this.parseUri(this.esUri)
  this.host = uri.host
  this.indexName = uri.indexName

  this.client = new elasticsearch.Client({
    host: this.host,
    requestTimeout: 5000,
    // log: 'debug',
  })

  this.registerUpdateEvent()

  this.mappingFile = crowi.resourceDir + 'search/mappings.json'
}

SearchClient.prototype.checkESVersion = function() {
  // TODO
}

SearchClient.prototype.registerUpdateEvent = function() {
  var pageEvent = this.crowi.event('page')
  pageEvent.on('create', this.syncPageCreated.bind(this))
  pageEvent.on('update', this.syncPageUpdated.bind(this))
  pageEvent.on('delete', this.syncPageDeleted.bind(this))
}

SearchClient.prototype.shouldIndexed = function(page) {
  // FIXME: Magic Number
  if (page.grant !== 1) {
    return false
  }

  if (page.redirectTo !== null) {
    return false
  }

  if (page.isDeleted()) {
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

SearchClient.prototype.buildIndex = function(uri) {
  return this.client.indices.create({
    index: this.indexName,
    body: require(this.mappingFile),
  })
}

SearchClient.prototype.deleteIndex = function(uri) {
  return this.client.indices.delete({
    index: this.indexName,
  })
}

SearchClient.prototype.prepareBodyForUpdate = function(body, page) {
  if (!Array.isArray(body)) {
    throw new Error('Body must be an array.')
  }

  var command = {
    update: {
      _index: this.indexName,
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

SearchClient.prototype.prepareBodyForCreate = function(body, page) {
  if (!Array.isArray(body)) {
    throw new Error('Body must be an array.')
  }

  var command = {
    index: {
      _index: this.indexName,
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

SearchClient.prototype.prepareBodyForDelete = function(body, page) {
  if (!Array.isArray(body)) {
    throw new Error('Body must be an array.')
  }

  var command = {
    delete: {
      _index: this.indexName,
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

SearchClient.prototype.addAllPages = function() {
  const self = this
  const Page = this.crowi.model('Page')
  const Bookmark = this.crowi.model('Bookmark')
  const cursor = Page.getStreamOfFindAll()
  let body = []
  let sent = 0
  let skipped = 0

  return new Promise(function(resolve, reject) {
    cursor
      .on('data', async function(doc) {
        if (!doc.creator || !doc.revision || !self.shouldIndexed(doc)) {
          // debug('Skipped', doc.path);
          skipped++
          return
        }

        const bookmarkCount = await Bookmark.countByPageId(doc._id)
        const page = { ...doc.toObject(), bookmarkCount }
        self.prepareBodyForCreate(body, page)
        // debug(body.length);
        if (body.length > 2000) {
          sent++
          debug('Sending request (seq, skipped)', sent, skipped)
          self.client
            .bulk({
              body: body,
              requestTimeout: Infinity,
            })
            .then(res => {
              debug('addAllPages add anyway (items, errors, took): ', (res.items || []).length, res.errors, res.took)
            })
            .catch(err => {
              debug('addAllPages error on add anyway: ', err)
            })

          body = []
        }
      })
      .on('error', function(err) {
        // TODO: handle err
        debug('Error cursor:', err)
      })
      .on('close', function() {
        // all done

        // 最後にすべてを送信
        debug('Sending last body of bulk operation:', body.length)
        self.client
          .bulk({
            body: body,
            requestTimeout: Infinity,
          })
          .then(function(res) {
            debug('Reponse from es (item length, errros, took):', (res.items || []).length, res.errors, res.took)
            return resolve(res)
          })
          .catch(function(err) {
            debug('Err from es:', err)
            return reject(err)
          })
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
            return { _id: elm._id, _score: elm._score }
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
  var fields = ['path']
  if (option) {
    fields = option.fields || fields
  }

  // default is only id field, sorted by updated_at
  var query = {
    index: this.indexName,
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
  var fields = ['path']
  if (option) {
    fields = option.fields || fields
  }

  // sort by score
  var query = {
    index: this.indexName,
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

SearchClient.prototype.searchKeyword = function(keyword, option) {
  const from = option.offset || null
  const size = option.limit || null
  const type = option.type || null
  const query = this.createSearchQuerySortedByScore()
  this.appendCriteriaForKeywordContains(query, keyword)

  this.filterPagesByType(query, type)

  this.appendResultSize(query, from, size)

  debug('searching ...', keyword, type)
  debug('filter', query.body.query.bool.filter)
  debug('must', query.body.query.bool.must)
  debug('must_not', query.body.query.bool.must_not)

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

module.exports = SearchClient
