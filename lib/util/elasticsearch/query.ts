import deepmerge from 'deepmerge'
import { Search as ES6Search } from 'es6/api/requestParams'
import { Search as ES7Search } from 'es7/api/requestParams'
import { TYPES, GRANT_RESTRICTED, GRANT_SPECIFIED, GRANT_OWNER } from 'server/models/page'
import { SearchQuery } from 'server/service/query'

export const defaultType = 'pages'
export const defaultFields = ['path', 'bookmark_count']
export const defaultOffset = 0
export const defaultLimit = 50
// TODO: By user's i18n setting, change boost or search target fields
export const defaultKeywordQueryFields = ['path.ja^2', 'body.ja', 'path.en^1.2', 'body.en']
// Not use "*.ja" fields here, because we want to analyze (parse) search words
export const defaultPhraseQueryFields = ['path.raw^2', 'body']

export const queries = {
  portal: {
    regexp: {
      'path.raw': '.*/',
    },
  },
  public: {
    regexp: {
      'path.raw': '.*[^/]',
    },
  },
  user: {
    prefix: {
      'path.raw': '/user/',
    },
  },
}

export type Search<T = any> = ES6Search<T> & ES7Search<T>
export type PickSearchBodyQuery<T extends Search<{ query: any }>> = T extends Search<{ query: infer U }> ? U : never
export type SearchWithBody<T = any> = Search<T> & { body: T }

const merge = <T1, T2>(x: T1, y: T2): T1 & T2 => deepmerge<T1, T2>(x, y)

interface Pipe {
  <T1, T2>(v: T1, f1: (a: T1) => T2): T2
  <T1, T2, T3>(v: T1, f1: (a: T1) => T2, f2: (a: T2) => T3): T3
  <T1, T2, T3, T4>(v: T1, f1: (a: T1) => T2, f2: (a: T2) => T3, f3: (a: T3) => T4): T4
  <T1, T2, T3, T4, T5>(v: T1, f1: (a: T1) => T2, f2: (a: T2) => T3, f3: (a: T3) => T4, f4: (a: T4) => T5): T5
  <T1, T2, T3, T4, T5, T6>(v: T1, f1: (a: T1) => T2, f2: (a: T2) => T3, f3: (a: T3) => T4, f4: (a: T4) => T5, f5: (a: T5) => T6): T6
}

export const pipe: Pipe = (v: any, ...fs: ((a: any) => any)[]) => fs.reduce((prev, next) => (value) => next(prev(value)))(v)

export type BaseQueryParams = {
  index: string
  type?: string
  fields?: string[]
}

export type BaseQueryResponse = { index: string; type: string; body: { query: Record<string, any>; _source: string[] } }

export const createBaseQuery = (params: BaseQueryParams): BaseQueryResponse => {
  const { index, type = defaultType, fields = defaultFields } = params
  return {
    index,
    type,
    body: {
      query: {},
      _source: fields,
    },
  }
}

export type FunctionScoreModifierType = 'log' | 'log1p' | 'log2p' | 'ln' | 'ln1p' | 'ln2p' | 'square' | 'sqrt' | 'reciprocal' | 'none'

export type FunctionScoreBoostModeType = 'multiply' | 'replace' | 'sum' | 'avg' | 'max' | 'min'

export type FunctionScoreFieldValueFactorType = {
  field: string
  factor?: number
  modifier?: FunctionScoreModifierType
  missing: number
}

export type FunctionScoreQueryParams = {
  fieldValueFactor: FunctionScoreFieldValueFactorType
  boostMode: FunctionScoreBoostModeType
}

export type FunctionScoreQueryResponse<T extends SearchWithBody> = T & {
  body: {
    query: { function_score: { query: PickSearchBodyQuery<T>; field_value_factor: FunctionScoreFieldValueFactorType; boost_mode: FunctionScoreBoostModeType } }
  }
}

export const createFunctionScoreQuery = <T extends SearchWithBody>(params: { query: T } & FunctionScoreQueryParams): FunctionScoreQueryResponse<T> => {
  const { query, fieldValueFactor: field_value_factor, boostMode: boost_mode } = params
  return {
    ...query,
    body: {
      ...query.body,
      query: {
        function_score: {
          query: query.body.query,
          field_value_factor,
          boost_mode,
        },
      },
    },
  }
}

export const convertToFunctionScoreQuery = <T extends SearchWithBody>(query: T, params: FunctionScoreQueryParams) => {
  return createFunctionScoreQuery({ query, ...params })
}

export type PagingParams = {
  from?: number
  size?: number
}

export type PagingResponse<T extends Search> = T & { from: number; size: number }

export const appendPaging = <T extends Search>(query: T, params: PagingParams = {}): PagingResponse<T> => {
  const { from = defaultOffset, size = defaultLimit } = params
  return merge(query, { from, size })
}

export type SortOrder = 'desc' | 'ask'

export type SortParams = Record<
  string,
  | SortOrder
  | {
      order?: SortOrder
      mode?: 'min' | 'max' | 'sum' | 'avg' | 'median'
    }
>

export type SortResponse<T extends Search, U extends SortParams> = T & { sort: U }

export const appendSort = <T extends Search, U extends SortParams>(query: T, params: U): SortResponse<T, U> => {
  return merge(query, { sort: params })
}

export type BoolQueryType = 'must' | 'filter' | 'should' | 'must_not'

export type BoolQuery<T> = Record<BoolQueryType, T[]>

export type BoolQueryParams<T> = {
  type: BoolQueryType
  query: T
}

export type BoolQueryResponse<T extends Search, U> = T & { body: { query: { bool: BoolQuery<U> } } }

export const appendBoolQuery = <T extends Search, U>(query: T, params: BoolQueryParams<U>): BoolQueryResponse<T, U> => {
  const { type, query: boolQuery } = params
  return merge(query, { body: { query: { bool: { [type]: [boolQuery] } as BoolQuery<U> } } })
}

export const appendBoolMustQuery = <T extends Search, U>(query: T, params: U) => {
  return appendBoolQuery(query, { type: 'must', query: params })
}

export const appendBoolShouldQuery = <T extends Search, U>(query: T, params: U) => {
  return appendBoolQuery(query, { type: 'should', query: params })
}

export const appendBoolFilterQuery = <T extends Search, U>(query: T, params: U) => {
  return appendBoolQuery(query, { type: 'filter', query: params })
}

export const appendBoolMustNotQuery = <T extends Search, U>(query: T, params: U) => {
  return appendBoolQuery(query, { type: 'must_not', query: params })
}

export const filterPortalPages = <T extends Search>(query: T) => {
  return pipe(
    query,
    (query) => appendBoolMustNotQuery(query, queries.user),
    (query) => appendBoolFilterQuery(query, queries.portal),
  )
}

export const filterPublicPages = <T extends Search>(query: T) => {
  return pipe(
    query,
    (query) => appendBoolMustNotQuery(query, queries.user),
    (query) => appendBoolMustNotQuery(query, queries.portal),
  )
}

export const filterUserPages = <T extends Search>(query: T) => {
  return appendBoolFilterQuery(query, queries.user)
}

export type FilterPagesByTypeParams = {
  type?: typeof TYPES[number]
}

export type FilterPagesByTypeFunction<T extends Search, U extends FilterPagesByTypeParams> = U extends { type?: infer R }
  ? R extends 'portal'
    ? typeof filterPortalPages
    : R extends 'public'
    ? typeof filterPublicPages
    : R extends 'user'
    ? typeof filterUserPages
    : T
  : never

export type FilterPagesByTypeResponse<T extends Search, U extends FilterPagesByTypeParams> = T & ReturnType<FilterPagesByTypeFunction<T, U>>

export const filterPagesByType = <T extends Search, U extends FilterPagesByTypeParams>(query: T, params: U) => {
  const { type } = params

  switch (type) {
    case 'portal':
      return filterPortalPages(query) as FilterPagesByTypeResponse<T, U>
    case 'public':
      return filterPublicPages(query) as FilterPagesByTypeResponse<T, U>
    case 'user':
      return filterUserPages(query) as FilterPagesByTypeResponse<T, U>
    default:
      return query as FilterPagesByTypeResponse<T, U>
  }
}

export type FilterPagesByUserParams = {
  username?: string | number
}

export type FilterPagesByUserResponse<T extends Search, U extends FilterPagesByUserParams> = U extends { username: string }
  ? BoolQueryResponse<T, { type: 'must_not'; query: { must_not: { match: { username: string } }; should: { match: { grant: number }[] } } }>
  : T

export const filterPagesByUser = <T extends Search, U extends FilterPagesByUserParams>(query: T, params: U) => {
  const { username } = params

  if (username) {
    return appendBoolMustNotQuery(query, {
      bool: {
        must_not: { match: { username } },
        should: [{ match: { grant: GRANT_RESTRICTED } }, { match: { grant: GRANT_SPECIFIED } }, { match: { grant: GRANT_OWNER } }],
      },
    }) as FilterPagesByUserResponse<T, U>
  }

  return query as FilterPagesByUserResponse<T, U>
}

type FilterPagesByPathParams = {
  path: string
}

export const filterPagesByPath = <T extends Search, U extends FilterPagesByPathParams>(query: T, params: U) => {
  const path = params.path.endsWith('/') ? params.path.slice(0, -1) : params.path

  return appendBoolFilterQuery(query, {
    wildcard: {
      'path.raw': `${path}/*`,
    },
  })
}

export type KeywordQueryType = 'positive' | 'negative'

export type KeywordQueryParams = {
  type: KeywordQueryType
  keywords: string[]
  fields?: string[]
  operator: string
}

export type KeywordQueryResponse<T extends Search> = BoolQueryResponse<
  T,
  {
    multi_match: {
      query: string
      fields: string[]
      operator: string
    }
  }
>

export const appendKeywordQuery = <T extends Search, U extends KeywordQueryParams>(query: T, params: U): T | KeywordQueryResponse<T> => {
  const { type, keywords, fields = defaultKeywordQueryFields, operator } = params

  if (keywords.length === 0) {
    return query
  }

  const appendQuery = {
    positive: appendBoolMustQuery,
    negative: appendBoolMustNotQuery,
  }[type]

  return appendQuery(query, {
    multi_match: {
      query: keywords.join(' '),
      fields,
      operator,
    },
  }) as KeywordQueryResponse<T>
}

export type PositiveKeywordQueryParams = {
  keywords: string[]
  fields?: string[]
}

export const appendPositiveKeywordQuery = <T extends Search, U extends PositiveKeywordQueryParams>(query: T, params: U) => {
  const { keywords, fields } = params

  return appendKeywordQuery(query, { type: 'positive', keywords, fields, operator: 'and' })
}

export type NegativeKeywordQueryParams = PositiveKeywordQueryParams

export const appendNegativeKeywordQuery = <T extends Search, U extends NegativeKeywordQueryParams>(query: T, params: U) => {
  const { keywords, fields } = params

  return appendKeywordQuery(query, { type: 'negative', keywords, fields, operator: 'or' })
}

export type PhraseQueryType = 'positive' | 'negative'

export type PhraseQueryParams = {
  type: PhraseQueryType
  phrases: string[]
  fields?: string[]
  operator: string
}

export type PhraseQueryResponse<T extends Search> = BoolQueryResponse<
  T,
  {
    multi_match: {
      type: 'phrase'
      query: string
      fields: string[]
      operator: string
    }
  }
>

export const appendPhraseQuery = <T extends Search, U extends PhraseQueryParams>(query: T, params: U): T | PhraseQueryResponse<T> => {
  const { type, phrases, fields = defaultPhraseQueryFields, operator } = params

  if (phrases.length === 0) {
    return query
  }

  const appendQuery = {
    positive: appendBoolMustQuery,
    negative: appendBoolMustNotQuery,
  }[type]

  return phrases.reduce(
    (query, phrase) =>
      appendQuery(query, {
        multi_match: {
          type: 'phrase',
          query: phrase,
          fields,
          operator,
        },
      }),
    query,
  ) as PhraseQueryResponse<T>
}

export type PositivePhraseQueryParams = {
  phrases: string[]
  fields?: string[]
}

export const appendPositivePhraseQuery = <T extends Search, U extends PositivePhraseQueryParams>(query: T, params: U) => {
  const { phrases, fields } = params

  return appendPhraseQuery(query, { type: 'positive', phrases, fields, operator: 'and' })
}

export type NegativePhraseQueryParams = PositivePhraseQueryParams

export const appendNegativePhraseQuery = <T extends Search, U extends NegativePhraseQueryParams>(query: T, params: U) => {
  const { phrases, fields } = params

  return appendPhraseQuery(query, { type: 'negative', phrases, fields, operator: 'or' })
}

export type SearchQueryParams = SearchQuery

export const appendSearchQuery = <T extends Search>(query: T, params: SearchQueryParams) => {
  const { keywords, phrases } = params

  return pipe(
    query,
    (query) => appendPositiveKeywordQuery(query, { keywords: keywords.positive }),
    (query) => appendNegativeKeywordQuery(query, { keywords: keywords.negative }),
    (query) => appendPositivePhraseQuery(query, { phrases: phrases.positive }),
    (query) => appendNegativePhraseQuery(query, { phrases: phrases.negative }),
  )
}

export class CreateQuery {
  private static createQueryMethod<T, U extends SearchWithBody>(func: (params: T) => U) {
    return (params: T) => new Query(func(params))
  }

  static createBaseQuery = CreateQuery.createQueryMethod(createBaseQuery)

  static createFunctionScoreQuery = CreateQuery.createQueryMethod(createFunctionScoreQuery)
}

export type Params<T extends (query, params) => any> = T extends (query, params: infer P) => any ? P : never

export class Query<T extends SearchWithBody> extends CreateQuery {
  private v: T

  constructor(value: T) {
    super()
    this.v = value
  }

  convertToFunctionScoreQuery(params: Params<typeof convertToFunctionScoreQuery>) {
    return new Query(convertToFunctionScoreQuery(this.value(), params))
  }

  appendPaging(params?: Params<typeof appendPaging>) {
    return new Query(appendPaging(this.value(), params))
  }

  appendSort(params: Params<typeof appendSort>) {
    return new Query(appendSort(this.value(), params))
  }

  appendBoolQuery(params: Params<typeof appendBoolQuery>) {
    return new Query(appendBoolQuery(this.value(), params))
  }

  appendBoolMustQuery(params: Params<typeof appendBoolMustQuery>) {
    return new Query(appendBoolMustQuery(this.value(), params))
  }

  appendBoolShouldQuery(params: Params<typeof appendBoolShouldQuery>) {
    return new Query(appendBoolShouldQuery(this.value(), params))
  }

  appendBoolFilterQuery(params: Params<typeof appendBoolFilterQuery>) {
    return new Query(appendBoolFilterQuery(this.value(), params))
  }

  appendBoolMustNotQuery(params: Params<typeof appendBoolMustNotQuery>) {
    return new Query(appendBoolMustNotQuery(this.value(), params))
  }

  filterPortalPages() {
    return new Query(filterPortalPages(this.value()))
  }

  filterPublicPages() {
    return new Query(filterPublicPages(this.value()))
  }

  filterUserPages() {
    return new Query(filterUserPages(this.value()))
  }

  filterPagesByType<U extends Params<typeof filterPagesByType>>(params: U) {
    return new Query(filterPagesByType(this.value(), params))
  }

  filterPagesByUser<U extends Params<typeof filterPagesByUser>>(params: U) {
    return new Query(filterPagesByUser(this.value(), params))
  }

  filterPagesByPath<U extends Params<typeof filterPagesByPath>>(params: U) {
    return new Query(filterPagesByPath(this.value(), params))
  }

  appendKeywordQuery<U extends Params<typeof appendKeywordQuery>>(params: U) {
    return new Query(appendKeywordQuery(this.value(), params))
  }

  appendPositiveKeywordQuery<U extends Params<typeof appendPositiveKeywordQuery>>(params: U) {
    return new Query(appendPositiveKeywordQuery(this.value(), params))
  }

  appendNegativeKeywordQuery<U extends Params<typeof appendNegativeKeywordQuery>>(params: U) {
    return new Query(appendNegativeKeywordQuery(this.value(), params))
  }

  appendPhraseQuery<U extends Params<typeof appendPhraseQuery>>(params: U) {
    return new Query(appendPhraseQuery(this.value(), params))
  }

  appendPositivePhraseQuery<U extends Params<typeof appendPositivePhraseQuery>>(params: U) {
    return new Query(appendPositivePhraseQuery(this.value(), params))
  }

  appendNegativePhraseQuery<U extends Params<typeof appendNegativePhraseQuery>>(params: U) {
    return new Query(appendNegativePhraseQuery(this.value(), params))
  }

  appendSearchQuery<U extends Params<typeof appendSearchQuery>>(params: U) {
    return new Query(appendSearchQuery(this.value(), params))
  }

  value() {
    return this.v
  }
}
