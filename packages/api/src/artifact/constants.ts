/**
 * Byte limits and reserved digest-marker names shared across the artifact
 * leaves (ingest, delivery-policy, write-path). This module intentionally
 * imports nothing — `models/config.ts` seeds config defaults from
 * `DEFAULT_ARTIFACT_MAX_BYTES` and is read by every process (server, CLI,
 * every test file) on startup, so if this module pulled in `ingest.ts`
 * (which loads parse5/PostCSS via jiti), every one of those processes would
 * pay the parser-load cost just to read a number.
 */

/** Default `maxBytes` for artifact ingest when no operator override is configured. */
export const DEFAULT_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;

/** Hard ceiling on `maxBytes`; also the fixed pre-parse input-size cap (AI-R01a). */
export const ARTIFACT_HARD_MAX_BYTES = 10 * 1024 * 1024;

/** Floor on the operator-configurable `maxBytes`. */
export const ARTIFACT_MIN_MAX_BYTES = 64 * 1024;

/**
 * Reserved `<meta name="…">` markers the normalizer places at the end of
 * `<head>`. The exact byte format they serialize to
 * (`<meta content="…" name="…"><meta content="…" name="…"></head>`) is a
 * cross-leaf contract: the delivery leaf extracts CSP hashes by string
 * matching against these names without re-parsing the document.
 */
export const ARTIFACT_SCRIPT_DIGEST_META_NAME = 'crowi-artifact-script-digests-v1';
export const ARTIFACT_STYLE_DIGEST_META_NAME = 'crowi-artifact-style-digests-v1';

/**
 * How many times `needle` occurs in `haystack`, counting non-overlapping
 * matches. It lives here because both the normalizer and the header builder
 * count marker occurrences, and this module is the one they can both import
 * without dragging a parser in.
 */
export function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
