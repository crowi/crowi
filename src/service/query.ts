export const normalize = (query: string) => {
  return query.trim().replace(/\s+/g, ' ')
}

export const splitKeywordsAndPhrases = (query: string) => {
  const phraseRegExp = /(-?"[^"]*")/g
  const keywords = query.replace(phraseRegExp, '').split(/\s+/g).filter(Boolean)
  const phrases = (query.match(phraseRegExp) || []).map(normalize)
  return { keywords, phrases }
}

export const splitPositiveAndNegative = (queries: string[]) => {
  const positive: string[] = []
  const negative: string[] = []
  queries.forEach((query) => {
    const isNegative = query.startsWith('-')
    const target = isNegative ? negative : positive
    const newQuery = isNegative ? query.substr(1) : query

    if (newQuery) {
      target.push(newQuery)
    }
  })
  return { positive, negative }
}

export const unquote = (query: string) => {
  return query.startsWith('-') ? `-${query.slice(2, -1)}` : query.slice(1, -1)
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
  const { positive: positiveKeywords, negative: negativeKeywords } = splitPositiveAndNegative(keywords)
  const { positive: positivePhrases, negative: negativePhrases } = splitPositiveAndNegative(phrases)

  return {
    keywords: {
      positive: positiveKeywords,
      negative: negativeKeywords,
    },
    phrases: {
      positive: positivePhrases.map(unquote).filter(Boolean),
      negative: negativePhrases.map(unquote).filter(Boolean),
    },
  }
}
