import {
  defaultFields,
  defaultKeywordQueryFields,
  defaultPhraseQueryFields,
  queries,
  createBaseQuery,
  createFunctionScoreQuery,
  convertToFunctionScoreQuery,
  appendPaging,
  appendSort,
  appendBoolQuery,
  appendBoolMustQuery,
  appendBoolShouldQuery,
  appendBoolFilterQuery,
  appendBoolMustNotQuery,
  filterPortalPages,
  filterPublicPages,
  filterUserPages,
  filterPagesByType,
  filterPagesByUser,
  filterPagesByPath,
  appendKeywordQuery,
  appendPositiveKeywordQuery,
  appendNegativeKeywordQuery,
  appendPhraseQuery,
  appendPositivePhraseQuery,
  appendNegativePhraseQuery,
  appendSearchQuery,
} from 'server/util/elasticsearch/query'
import { GRANT_RESTRICTED, GRANT_SPECIFIED, GRANT_OWNER } from 'server/models/page'

describe('createBaseQuery', () => {
  const index = 'crowi'
  const type = 'test'
  it('should create base query', () => {
    expect(createBaseQuery({ index, type })).toEqual({
      index,
      type,
      body: {
        query: {},
        _source: defaultFields,
      },
    })
    const fields = ['test']
    expect(createBaseQuery({ index, type, fields })).toEqual({
      index,
      type,
      body: {
        query: {},
        _source: fields,
      },
    })
  })
})

describe('createFunctionScoreQuery', () => {
  const query = 'test'
  const fieldValueFactor = {
    field: 'bookmark_count',
    modifier: 'log1p',
    factor: 1,
    missing: 0,
  } as const
  const boostMode = 'sum'
  it('should create function score query', () => {
    expect(
      createFunctionScoreQuery({
        query: { body: { query } },
        fieldValueFactor,
        boostMode,
      }),
    ).toEqual({
      body: {
        query: {
          function_score: {
            query,
            field_value_factor: fieldValueFactor,
            boost_mode: boostMode,
          },
        },
      },
    })
  })
})

describe('convertToFunctionScoreQuery', () => {
  const index = 'crowi'
  const query = createBaseQuery({ index })
  const fieldValueFactor = {
    field: 'bookmark_count',
    modifier: 'log1p',
    factor: 1,
    missing: 0,
  } as const
  const boostMode = 'sum'
  it('should convert a query to a function score query', () => {
    expect(convertToFunctionScoreQuery(query, { fieldValueFactor, boostMode })).toEqual({
      ...query,
      body: {
        ...query.body,
        query: {
          function_score: {
            query: query.body.query,
            field_value_factor: fieldValueFactor,
            boost_mode: boostMode,
          },
        },
      },
    })
  })
})

const baseQuery = createBaseQuery({ index: 'test' })

describe('appendPaging', () => {
  const params = { from: 1, size: 2 }
  it('should return value containing from property', () => {
    expect(appendPaging(baseQuery, params).from).toEqual(params.from)
  })
  it('should return value containing size property', () => {
    expect(appendPaging(baseQuery, params).size).toEqual(params.size)
  })
})

describe('appendSort', () => {
  const params = { _score: 'desc' } as const
  it('should return value containing size property', () => {
    expect(appendSort(baseQuery, params).sort).toEqual(params)
  })
})

const boolQuery = {
  regexp: {
    'path.raw': '.*/',
  },
}

describe('appendBoolQuery', () => {
  it('should append bool query', () => {
    expect(appendBoolQuery(baseQuery, { type: 'must', query: boolQuery }).body.query.bool.must).toEqual([boolQuery])
  })
})

describe('appendBoolMustQuery', () => {
  it('should append bool must query', () => {
    expect(appendBoolMustQuery(baseQuery, boolQuery).body.query.bool.must).toEqual([boolQuery])
  })
})

describe('appendBoolShouldQuery', () => {
  it('should append bool should query', () => {
    expect(appendBoolShouldQuery(baseQuery, boolQuery).body.query.bool.should).toEqual([boolQuery])
  })
})

describe('appendBoolFilterQuery', () => {
  it('should append bool filter query', () => {
    expect(appendBoolFilterQuery(baseQuery, boolQuery).body.query.bool.filter).toEqual([boolQuery])
  })
})

describe('appendBoolMustNotQuery', () => {
  it('should append bool must not query', () => {
    expect(appendBoolMustNotQuery(baseQuery, boolQuery).body.query.bool.must_not).toEqual([boolQuery])
  })
})

describe('filterPortalPages', () => {
  it('should filter portal pages', () => {
    expect(filterPortalPages(baseQuery).body.query.bool.must_not).toEqual([queries.user])
    expect(filterPortalPages(baseQuery).body.query.bool.filter).toEqual([queries.portal])
  })
})

describe('filterPublicPages', () => {
  it('should filter public pages', () => {
    expect(filterPublicPages(baseQuery).body.query.bool.must_not).toEqual([queries.user, queries.portal])
  })
})

describe('filterUserPages', () => {
  it('should filter user pages', () => {
    expect(filterUserPages(baseQuery).body.query.bool.filter).toEqual([queries.user])
  })
})

describe('filterPagesByType', () => {
  it('should filter pages by type', () => {
    expect(filterPagesByType(baseQuery, { type: 'portal' })).toEqual(filterPortalPages(baseQuery))
    expect(filterPagesByType(baseQuery, { type: 'public' })).toEqual(filterPublicPages(baseQuery))
    expect(filterPagesByType(baseQuery, { type: 'user' })).toEqual(filterUserPages(baseQuery))
  })
})

describe('filterPagesByUser', () => {
  const username = 'lightnet328'
  it('should filter pages by user', () => {
    expect(filterPagesByUser(baseQuery, { username }).body.query.bool.must_not).toEqual([
      {
        bool: {
          must_not: { match: { username } },
          should: [{ match: { grant: GRANT_RESTRICTED } }, { match: { grant: GRANT_SPECIFIED } }, { match: { grant: GRANT_OWNER } }],
        },
      },
    ])
  })
})

describe('filterPagesByPath', () => {
  it('should filter pages by path', () => {
    expect(filterPagesByPath(baseQuery, { path: '/hoge' }).body.query.bool.filter).toEqual([
      {
        wildcard: {
          'path.raw': `/hoge/*`,
        },
      },
    ])
    expect(filterPagesByPath(baseQuery, { path: '/hoge/' }).body.query.bool.filter).toEqual([
      {
        wildcard: {
          'path.raw': `/hoge/*`,
        },
      },
    ])
  })
})

const keywords = ['crowi', 'markdown']

describe('appendKeywordQuery', () => {
  const query = keywords.join(' ')
  it('should append keyword query', () => {
    expect(appendKeywordQuery(baseQuery, { type: 'positive', keywords, operator: 'and' }).body.query).toHaveProperty('bool.must', [
      {
        multi_match: {
          query,
          fields: defaultKeywordQueryFields,
          operator: 'and',
        },
      },
    ])
    expect(appendKeywordQuery(baseQuery, { type: 'negative', keywords, operator: 'or' }).body.query).toHaveProperty('bool.must_not', [
      {
        multi_match: {
          query,
          fields: defaultKeywordQueryFields,
          operator: 'or',
        },
      },
    ])
  })
})

describe('appendPositiveKeywordQuery', () => {
  it('should append positive keyword query', () => {
    expect(appendPositiveKeywordQuery(baseQuery, { keywords })).toEqual(appendKeywordQuery(baseQuery, { type: 'positive', keywords, operator: 'and' }))
  })
})

describe('appendNegativeKeywordQuery', () => {
  it('should append negative keyword query', () => {
    expect(appendNegativeKeywordQuery(baseQuery, { keywords })).toEqual(appendKeywordQuery(baseQuery, { type: 'negative', keywords, operator: 'or' }))
  })
})

const phrases = ['happy halloween', 'trick or treat']

describe('appendPhraseQuery', () => {
  it('should append phrase query', () => {
    expect(appendPhraseQuery(baseQuery, { type: 'positive', phrases, operator: 'and' }).body.query).toHaveProperty('bool.must', [
      {
        multi_match: {
          type: 'phrase',
          query: phrases[0],
          fields: defaultPhraseQueryFields,
          operator: 'and',
        },
      },
      {
        multi_match: {
          type: 'phrase',
          query: phrases[1],
          fields: defaultPhraseQueryFields,
          operator: 'and',
        },
      },
    ])
    expect(appendPhraseQuery(baseQuery, { type: 'negative', phrases, operator: 'or' }).body.query).toHaveProperty('bool.must_not', [
      {
        multi_match: {
          type: 'phrase',
          query: phrases[0],
          fields: defaultPhraseQueryFields,
          operator: 'or',
        },
      },
      {
        multi_match: {
          type: 'phrase',
          query: phrases[1],
          fields: defaultPhraseQueryFields,
          operator: 'or',
        },
      },
    ])
  })
})

describe('appendPositivePhraseQuery', () => {
  it('should append positive phrase query', () => {
    expect(appendPositivePhraseQuery(baseQuery, { phrases })).toEqual(appendPhraseQuery(baseQuery, { type: 'positive', phrases, operator: 'and' }))
  })
})

describe('appendNegativePhraseQuery', () => {
  it('should append negative phrase query', () => {
    expect(appendNegativePhraseQuery(baseQuery, { phrases })).toEqual(appendPhraseQuery(baseQuery, { type: 'negative', phrases, operator: 'or' }))
  })
})

describe('appendSearchQuery', () => {
  it('should append search query', () => {
    expect(
      appendSearchQuery(baseQuery, {
        keywords: { positive: keywords, negative: keywords },
        phrases: { positive: phrases, negative: phrases },
      }).body.query,
    ).toHaveProperty('bool.must', [
      {
        multi_match: {
          query: keywords.join(' '),
          fields: defaultKeywordQueryFields,
          operator: 'and',
        },
      },
      {
        multi_match: {
          type: 'phrase',
          query: phrases[0],
          fields: defaultPhraseQueryFields,
          operator: 'and',
        },
      },
      {
        multi_match: {
          type: 'phrase',
          query: phrases[1],
          fields: defaultPhraseQueryFields,
          operator: 'and',
        },
      },
    ])
    expect(
      appendSearchQuery(baseQuery, {
        keywords: { positive: keywords, negative: keywords },
        phrases: { positive: phrases, negative: phrases },
      }).body.query,
    ).toHaveProperty('bool.must_not', [
      {
        multi_match: {
          query: keywords.join(' '),
          fields: defaultKeywordQueryFields,
          operator: 'or',
        },
      },
      {
        multi_match: {
          type: 'phrase',
          query: phrases[0],
          fields: defaultPhraseQueryFields,
          operator: 'or',
        },
      },
      {
        multi_match: {
          type: 'phrase',
          query: phrases[1],
          fields: defaultPhraseQueryFields,
          operator: 'or',
        },
      },
    ])
  })
})
