export const normalize = (query: string) => {
  return query.trim().replace(/\s+/g, ' ')
}

export const splitKeywordsAndPhrases = (query: string) => {
  const phraseRegExp = /(-?"[^"]+")/g
  const keywords = query
    .replace(phraseRegExp, '')
    .split(' ')
    .filter(Boolean)
  const phrases = (query.match(phraseRegExp) || []).map(normalize).map(phrase => phrase.slice(1, -1))
  return { keywords, phrases }
}

export const splitPositiveAndNegative = (queries: string[]) => {
  const positive: string[] = []
  const negative: string[] = []
  queries.forEach(query => {
    const isNegative = query.startsWith('-')
    const target = isNegative ? negative : positive
    const newQuery = isNegative ? query.substr(1) : query

    if (newQuery) {
      target.push(newQuery)
    }
  })
  return { positive, negative }
}

type PositiveAndNegative<T> = {
  positive: T
  negative: T
}

export type SearchQuery = {
  keywords: PositiveAndNegative<string[]>
  phrases: PositiveAndNegative<string[]>
}

export const parseQuery = (query: string): SearchQuery => {
  const { keywords, phrases } = splitKeywordsAndPhrases(normalize(query))

  return {
    keywords: splitPositiveAndNegative(keywords),
    phrases: splitPositiveAndNegative(phrases),
  }
}
