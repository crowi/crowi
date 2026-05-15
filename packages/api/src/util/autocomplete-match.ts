/**
 * RFC-0004 Phase 5 — pure matching / scoring for autocomplete.
 *
 * The autocomplete endpoints over-fetch a candidate set from Mongo
 * (a case-insensitive substring query is the widest filter the index
 * can serve cheaply) and then rank it here. Ranking is the RFC's
 * three-tier order — **prefix > substring > fuzzy** — applied across
 * the per-entity fields, each field carrying its own weight:
 *
 *   - users: `username` (highest) > display name > email-local-part
 *   - pages: full `path` (highest) > path leaf ("title")
 *
 * Keeping this logic as a pure, field-agnostic function makes the
 * tiering testable without a database and lets both endpoints share
 * one implementation.
 */

/** Match tier, best first. `null` means the candidate does not match. */
export type MatchTier = 'prefix' | 'substring' | 'fuzzy' | null;

/**
 * Classify how `query` matches `text` (both compared lower-cased).
 *  - `prefix`    — `text` starts with `query`.
 *  - `substring` — `query` appears somewhere inside `text`.
 *  - `fuzzy`     — every `query` character appears in `text` in order
 *                  (subsequence match), e.g. `apc` ⊑ `api-spec`.
 *  - `null`      — no match.
 */
export function classifyMatch(text: string, query: string): MatchTier {
  if (query.length === 0) return null;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (t.startsWith(q)) return 'prefix';
  if (t.includes(q)) return 'substring';
  return isSubsequence(q, t) ? 'fuzzy' : null;
}

/** True when every char of `needle` appears in `haystack` in order. */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/** Base score per tier. Wider gaps than the field weights so a better
 *  tier on a lower-weight field still outranks a worse tier on a
 *  higher-weight field. */
const TIER_SCORE: Record<Exclude<MatchTier, null>, number> = {
  prefix: 300,
  substring: 200,
  fuzzy: 100,
};

/**
 * A single weighted field of a candidate. `weight` is added to the
 * tier score so, within one tier, higher-weight fields rank first.
 */
export interface ScoredField {
  text: string;
  weight: number;
}

/**
 * Score a candidate against `query` over its weighted fields. The
 * candidate's score is the best (highest) field score; a candidate
 * with no matching field scores 0 and should be dropped.
 *
 * A short bonus rewards exact-length prefix matches (the typed query
 * *is* the field) so e.g. typing `@bob` floats `bob` above `bobby`.
 */
export function scoreCandidate(fields: ScoredField[], query: string): number {
  let best = 0;
  for (const field of fields) {
    const tier = classifyMatch(field.text, query);
    if (tier === null) continue;
    let score = TIER_SCORE[tier] + field.weight;
    if (tier === 'prefix' && field.text.toLowerCase() === query.toLowerCase()) {
      score += 50; // exact full-field match
    }
    if (score > best) best = score;
  }
  return best;
}
