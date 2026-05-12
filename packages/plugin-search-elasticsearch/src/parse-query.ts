/**
 * Search-string parser for the Elasticsearch driver.
 *
 * Splits a free-form query into positive / negative keywords and
 * phrases. Lifted from the legacy `packages/api/src/service/query.ts`
 * with no behaviour changes — preserved here as a plugin-private
 * helper because the parser is currently ES-specific (the +/- and
 * `"phrase"` syntax maps directly to ES `multi_match` queries). When
 * a future driver wants the same shape, factor it back into
 * `@crowi/plugin-api`.
 */

export type PositiveAndNegative<T> = {
  positive: T;
  negative: T;
};

export type ParsedSearchQuery = {
  keywords: PositiveAndNegative<string[]>;
  phrases: PositiveAndNegative<string[]>;
};

export const normalize = (query: string): string => {
  return query.trim().replace(/\s+/g, ' ');
};

export const splitKeywordsAndPhrases = (query: string): { keywords: string[]; phrases: string[] } => {
  const phraseRegExp = /(-?"[^"]*")/g;
  const keywords = query.replace(phraseRegExp, '').split(/\s+/g).filter(Boolean);
  const phrases = (query.match(phraseRegExp) || []).map(normalize);
  return { keywords, phrases };
};

export const splitPositiveAndNegative = (queries: string[]): PositiveAndNegative<string[]> => {
  const positive: string[] = [];
  const negative: string[] = [];
  for (const query of queries) {
    const isNegative = query.startsWith('-');
    const target = isNegative ? negative : positive;
    const newQuery = isNegative ? query.substring(1) : query;

    if (newQuery) {
      target.push(newQuery);
    }
  }
  return { positive, negative };
};

/**
 * Strip the surrounding `"` quotes from a phrase token. Negative
 * markers (`-`) are stripped earlier by `splitPositiveAndNegative`,
 * so by the time we get here the input is always `"…"`.
 */
export const unquote = (query: string): string => {
  return query.slice(1, -1);
};

export const parseQuery = (query: string): ParsedSearchQuery => {
  const { keywords, phrases } = splitKeywordsAndPhrases(normalize(query));
  const { positive: positiveKeywords, negative: negativeKeywords } = splitPositiveAndNegative(keywords);
  const { positive: positivePhrases, negative: negativePhrases } = splitPositiveAndNegative(phrases);

  return {
    keywords: {
      positive: positiveKeywords,
      negative: negativeKeywords,
    },
    phrases: {
      positive: positivePhrases.map(unquote).filter(Boolean),
      negative: negativePhrases.map(unquote).filter(Boolean),
    },
  };
};
