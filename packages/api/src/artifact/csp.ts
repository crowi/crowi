/**
 * Pure digest-marker extraction and CSP header assembly for HTML artifact
 * responses. Both functions are string-only: no HTML parser, no DB, no
 * HTTP. `./constants` supplies the reserved marker names (never
 * `./ingest`, which would pull parse5/PostCSS into every process that loads
 * this module — see that module's own doc comment).
 *
 * `<meta http-equiv="Content-Security-Policy">` is NOT used anywhere here —
 * `buildArtifactContentSecurityPolicy` only returns the string a caller puts
 * in the `Content-Security-Policy` HTTP response header.
 */

import { ARTIFACT_SCRIPT_DIGEST_META_NAME, ARTIFACT_STYLE_DIGEST_META_NAME, countOccurrences } from './constants';
import { ARTIFACT_HEIGHT_REPORTER_DIGEST } from './height-reporter';
import type { ArtifactPolicySnapshot } from './policy';

// ---------------------------------------------------------------------------
// §P 表 — policy error result union
// ---------------------------------------------------------------------------

export type ArtifactPolicyErrorCode = 'MARKER_MISSING' | 'MARKER_DUPLICATE' | 'MARKER_MALFORMED' | 'DIGEST_TOKEN_INVALID' | 'DELIVERY_DISABLED';

export interface ArtifactPolicyError {
  readonly ok: false;
  readonly code: ArtifactPolicyErrorCode;
  readonly message: string;
}

/** Fixed English messages only — never the marker content, a token, or artifact body text (§Error semantics). */
export const ARTIFACT_POLICY_ERROR_MESSAGES: Readonly<Record<ArtifactPolicyErrorCode, string>> = {
  MARKER_MISSING: 'Artifact body is missing a required digest marker.',
  MARKER_DUPLICATE: 'Artifact body has a duplicated digest marker.',
  MARKER_MALFORMED: 'Artifact body digest markers are malformed.',
  DIGEST_TOKEN_INVALID: 'Artifact digest marker content is invalid.',
  DELIVERY_DISABLED: 'Artifact delivery is disabled.',
};

function policyError(code: ArtifactPolicyErrorCode): ArtifactPolicyError {
  return { ok: false, code, message: ARTIFACT_POLICY_ERROR_MESSAGES[code] };
}

// ---------------------------------------------------------------------------
// §X 表 — digest marker extraction
// ---------------------------------------------------------------------------

export type ArtifactDigestMarkers = Readonly<{ scriptDigests: string; styleDigests: string }>;

export type ArtifactDigestMarkersResult = { readonly ok: true; readonly markers: ArtifactDigestMarkers } | ArtifactPolicyError;

/**
 * §X 表 — takes the exact serialization form the core ingest leaf produces
 * (attributes name-sorted, `content` before `name`, script marker then style
 * marker as the last 2 children of `<head>`, immediately followed by
 * `</head>`) and extracts each marker's `content` value by string position
 * only — never a general HTML parser, which lookalike content (raw
 * `<script>`/`<style>` bodies, unescaped `<` in attribute values) could
 * fool. Reserved `name` occurring more than once anywhere in `body` fails
 * closed regardless of position (§X-1) — a forged/duplicated marker could
 * otherwise smuggle an attacker-chosen digest into the CSP header.
 */
export function extractArtifactDigestMarkers(body: string): ArtifactDigestMarkersResult {
  // X-1
  const scriptNameCount = countOccurrences(body, ARTIFACT_SCRIPT_DIGEST_META_NAME);
  const styleNameCount = countOccurrences(body, ARTIFACT_STYLE_DIGEST_META_NAME);
  if (scriptNameCount === 0 || styleNameCount === 0) return policyError('MARKER_MISSING');
  if (scriptNameCount >= 2 || styleNameCount >= 2) return policyError('MARKER_DUPLICATE');

  // X-2
  const OPEN = '<meta content="';
  const SCRIPT_TAIL = `" name="${ARTIFACT_SCRIPT_DIGEST_META_NAME}">`;
  const scriptTailIndex = body.indexOf(SCRIPT_TAIL);
  if (scriptTailIndex === -1) return policyError('MARKER_MALFORMED');
  const scriptOpenIndex = body.lastIndexOf(OPEN, scriptTailIndex);
  if (scriptOpenIndex === -1) return policyError('MARKER_MALFORMED');
  const scriptContent = body.slice(scriptOpenIndex + OPEN.length, scriptTailIndex);
  if (scriptContent.includes('"') || scriptContent.includes('<')) return policyError('MARKER_MALFORMED');

  // X-3
  const STYLE_TAIL = `" name="${ARTIFACT_STYLE_DIGEST_META_NAME}">`;
  const afterScriptTail = scriptTailIndex + SCRIPT_TAIL.length;
  if (!body.startsWith(OPEN, afterScriptTail)) return policyError('MARKER_MALFORMED');
  const styleContentStart = afterScriptTail + OPEN.length;
  const styleTailIndex = body.indexOf(STYLE_TAIL, styleContentStart);
  if (styleTailIndex === -1) return policyError('MARKER_MALFORMED');
  const styleContent = body.slice(styleContentStart, styleTailIndex);
  if (styleContent.includes('"') || styleContent.includes('<')) return policyError('MARKER_MALFORMED');

  // X-4
  const afterStyleTail = styleTailIndex + STYLE_TAIL.length;
  if (!body.startsWith('</head>', afterStyleTail)) return policyError('MARKER_MALFORMED');

  // X-5
  return { ok: true, markers: { scriptDigests: scriptContent, styleDigests: styleContent } };
}

// ---------------------------------------------------------------------------
// §G 表 — digest token grammar
// ---------------------------------------------------------------------------

/** §G-1 — `sha256-` + the standard (not base64url) base64 encoding of a 32-byte SHA-256 digest, which is always exactly 43 chars + 1 `=` pad char. */
export const ARTIFACT_DIGEST_TOKEN_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/;

/** Any ASCII control character (0x00-0x1F, 0x7F) — covers tab/CR/LF/FF as a subset. Deliberately matches control characters (that's the point of the check). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\x00-\x1F\x7F]/;

/** `'` / `"` / `;` / `<` — characters `buildArtifactContentSecurityPolicy` must never let into a CSP header value. */
const FORBIDDEN_CONTENT_CHAR_PATTERN = /['";<]/;

/**
 * §G-2 / §G-3 — parses a marker's `content` into its token list, or `null`
 * if it violates the grammar (empty is valid: an empty script/style marker
 * means "0 inline scripts/styles" — §D 表 renders an empty style list as
 * `'none'`, and an empty script list as the height reporter's digest alone).
 */
export function parseArtifactDigestContent(content: string): readonly string[] | null {
  if (content === '') return [];
  if (content !== content.trim()) return null;
  if (content.includes('  ')) return null;
  if (CONTROL_CHAR_PATTERN.test(content)) return null;
  if (FORBIDDEN_CONTENT_CHAR_PATTERN.test(content)) return null;

  const tokens = content.split(' ');
  for (const token of tokens) {
    if (!ARTIFACT_DIGEST_TOKEN_PATTERN.test(token)) return null;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// §D 表 — CSP header assembly
// ---------------------------------------------------------------------------

export const GOOGLE_FONTS_STYLE_ORIGIN = 'https://fonts.googleapis.com';
export const GOOGLE_FONTS_FONT_ORIGIN = 'https://fonts.gstatic.com';

export type ArtifactCspResult = { readonly ok: true; readonly header: string } | ArtifactPolicyError;

const quoteTokens = (tokens: readonly string[]): string => tokens.map((token) => `'${token}'`).join(' ');

/**
 * Deterministic, pure directive assembly. `sandbox allow-scripts` is emitted
 * unconditionally, in EVERY mode: the recommended reverse-proxy topology
 * also reaches the delivery route from the Crowi origin via `/api/*`
 * rewrites, so gating `sandbox` on mode alone would let a response reached
 * through that path execute unsandboxed on the Crowi origin.
 */
export function buildArtifactContentSecurityPolicy(markers: ArtifactDigestMarkers, snapshot: ArtifactPolicySnapshot): ArtifactCspResult {
  if (snapshot.deliveryMode === 'disabled' || snapshot.crowiOrigin === null) return policyError('DELIVERY_DISABLED');

  const scriptTokens = parseArtifactDigestContent(markers.scriptDigests);
  const styleTokens = parseArtifactDigestContent(markers.styleDigests);
  if (scriptTokens === null || styleTokens === null) return policyError('DIGEST_TOKEN_INVALID');

  // Delivery appends the height reporter to every served artifact, so its
  // digest leads the list even when the author's document has no scripts.
  const scriptSrc = `script-src ${quoteTokens([ARTIFACT_HEIGHT_REPORTER_DIGEST, ...scriptTokens])}`;

  let styleSrc: string;
  if (styleTokens.length === 0) {
    styleSrc = snapshot.allowWebFonts ? `style-src ${GOOGLE_FONTS_STYLE_ORIGIN}` : "style-src 'none'";
  } else {
    styleSrc = `style-src ${quoteTokens(styleTokens)}${snapshot.allowWebFonts ? ` ${GOOGLE_FONTS_STYLE_ORIGIN}` : ''}`;
  }

  const directives = [
    "default-src 'none'", // D-1
    scriptSrc, // D-2
    styleSrc, // D-3
    'img-src data: blob:', // D-4
    ...(snapshot.allowWebFonts ? [`font-src ${GOOGLE_FONTS_FONT_ORIGIN}`] : []), // D-5
    "connect-src 'none'", // D-6
    `frame-ancestors ${snapshot.crowiOrigin}`, // D-7
    "form-action 'none'", // D-8
    "base-uri 'none'", // D-9
    'sandbox allow-scripts', // D-10 — always, regardless of mode
  ];

  return { ok: true, header: directives.join('; ') };
}
