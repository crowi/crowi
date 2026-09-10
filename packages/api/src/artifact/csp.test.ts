import { createHash } from 'node:crypto';
import { ingestHtmlArtifact } from './ingest';
import { ARTIFACT_SCRIPT_DIGEST_META_NAME, ARTIFACT_STYLE_DIGEST_META_NAME } from './constants';
import {
  ARTIFACT_POLICY_ERROR_MESSAGES,
  buildArtifactContentSecurityPolicy,
  extractArtifactDigestMarkers,
  GOOGLE_FONTS_FONT_ORIGIN,
  GOOGLE_FONTS_STYLE_ORIGIN,
  parseArtifactDigestContent,
} from './csp';
import type { ArtifactPolicySnapshot } from './policy';

// ---------------------------------------------------------------------------
// Fixtures — real ingestHtmlArtifact output, per the leaf spec's requirement
// that csp.test.ts fixtures come from the actual ingest pipeline (not
// hand-written marker strings) so the extraction contract tracks the core
// leaf's real serialization form.
// ---------------------------------------------------------------------------

function sha256Token(text: string): string {
  return `sha256-${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('base64')}`;
}

function buildArtifactHtml(opts: { scripts?: string[]; styles?: string[]; extraHead?: string; extraBody?: string }): string {
  const styles = (opts.styles ?? []).map((s) => `<style>${s}</style>`).join('\n');
  const scripts = (opts.scripts ?? []).map((s) => `<script>${s}</script>`).join('\n');
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    styles,
    scripts,
    opts.extraHead ?? '',
    '</head>',
    '<body>',
    '<p>hello from the artifact fixture</p>',
    opts.extraBody ?? '',
    '</body>',
    '</html>',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

async function ingestValidArtifact(html: string): Promise<string> {
  const result = await ingestHtmlArtifact(html, { source: 'author', allowWebFonts: false, maxBytes: 2 * 1024 * 1024 });
  if (!result.ok) {
    throw new Error(`fixture unexpectedly rejected: ${JSON.stringify(result.rejection)}`);
  }
  return Buffer.from(result.bytes).toString('utf8');
}

const MODE_A_SNAPSHOT = (allowWebFonts: boolean): ArtifactPolicySnapshot =>
  Object.freeze({
    deliveryMode: 'separate-origin',
    artifactOrigin: 'https://artifacts.example.net',
    crowiOrigin: 'https://wiki.example.com',
    writeEnabled: true,
    allowWebFonts,
    maxBytes: 2 * 1024 * 1024,
  });

const MODE_B_SNAPSHOT = (allowWebFonts: boolean): ArtifactPolicySnapshot =>
  Object.freeze({
    deliveryMode: 'same-origin',
    artifactOrigin: 'https://wiki.example.com',
    crowiOrigin: 'https://wiki.example.com',
    writeEnabled: true,
    allowWebFonts,
    maxBytes: 2 * 1024 * 1024,
  });

const DISABLED_SNAPSHOT: ArtifactPolicySnapshot = Object.freeze({
  deliveryMode: 'disabled',
  artifactOrigin: null,
  crowiOrigin: 'https://wiki.example.com',
  writeEnabled: false,
  allowWebFonts: false,
  maxBytes: 2 * 1024 * 1024,
});

// ---------------------------------------------------------------------------
// extractArtifactDigestMarkers — §X 表
// ---------------------------------------------------------------------------

describe('extractArtifactDigestMarkers', () => {
  it('X-5: extracts both markers from a real ingested document (0 scripts, 0 styles)', async () => {
    const body = await ingestValidArtifact(buildArtifactHtml({}));
    const result = extractArtifactDigestMarkers(body);
    expect(result).toEqual({ ok: true, markers: { scriptDigests: '', styleDigests: '' } });
  });

  it('X-5: extracts both markers from a real ingested document (1 script, 1 style) matching independently-computed digests', async () => {
    const scriptText = "console.log('crowi-artifact');";
    const styleText = 'body { color: rebeccapurple; }';
    const body = await ingestValidArtifact(buildArtifactHtml({ scripts: [scriptText], styles: [styleText] }));
    const result = extractArtifactDigestMarkers(body);
    expect(result).toEqual({ ok: true, markers: { scriptDigests: sha256Token(scriptText), styleDigests: sha256Token(styleText) } });
  });

  it('X-5: extracts multiple digests per kind (2 scripts, 3 styles), space-joined in document order', async () => {
    const scripts = ['console.log(0);', 'console.log(1);'];
    const styles = ['.a{color:red}', '.b{color:blue}', '.c{color:green}'];
    const body = await ingestValidArtifact(buildArtifactHtml({ scripts, styles }));
    const result = extractArtifactDigestMarkers(body);
    expect(result).toEqual({
      ok: true,
      markers: { scriptDigests: scripts.map(sha256Token).join(' '), styleDigests: styles.map(sha256Token).join(' ') },
    });
  });

  it('X-5: digests inside SVG <script>/<style> and <template> content are extracted the same as HTML-namespace ones', async () => {
    const svgScript = 'if (a &lt; b) { c(); }';
    const svgStyle = '.a{fill:red}';
    const templateScript = 'console.log(1)';
    const body = await ingestValidArtifact(
      buildArtifactHtml({
        extraBody: `<svg xmlns="http://www.w3.org/2000/svg"><script>${svgScript}</script><style>${svgStyle}</style></svg><template><script>${templateScript}</script></template>`,
      }),
    );
    const result = extractArtifactDigestMarkers(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The SVG script text is escaped on the wire (`&lt;` -> `<`) before hashing.
    expect(result.markers.scriptDigests).toBe([sha256Token('if (a < b) { c(); }'), sha256Token(templateScript)].join(' '));
    expect(result.markers.styleDigests).toBe(sha256Token(svgStyle));
  });

  describe('P-1: MARKER_MISSING', () => {
    it('both markers absent (no artifact document at all)', () => {
      expect(extractArtifactDigestMarkers('<html><head></head><body></body></html>')).toEqual({
        ok: false,
        code: 'MARKER_MISSING',
        message: ARTIFACT_POLICY_ERROR_MESSAGES.MARKER_MISSING,
      });
    });

    it('the script marker alone is removed from an otherwise-valid document', async () => {
      const body = await ingestValidArtifact(buildArtifactHtml({ scripts: ['console.log(1)'] }));
      const withoutScriptMarker = body.replace(new RegExp(`<meta content="[^"]*" name="${ARTIFACT_SCRIPT_DIGEST_META_NAME}">`), '');
      expect(extractArtifactDigestMarkers(withoutScriptMarker)).toMatchObject({ ok: false, code: 'MARKER_MISSING' });
    });

    it('an unknown marker version (-v2) does not satisfy the v1 name', async () => {
      const body = await ingestValidArtifact(buildArtifactHtml({ scripts: ['console.log(1)'] }));
      const renamed = body.replace(ARTIFACT_SCRIPT_DIGEST_META_NAME, `${ARTIFACT_SCRIPT_DIGEST_META_NAME.replace('-v1', '-v2')}`);
      expect(extractArtifactDigestMarkers(renamed)).toMatchObject({ ok: false, code: 'MARKER_MISSING' });
    });
  });

  describe('P-2: MARKER_DUPLICATE', () => {
    it('the reserved script name reappears inside an HTML comment', async () => {
      const body = await ingestValidArtifact(buildArtifactHtml({}));
      const withComment = body.replace('<body>', `<body><!-- ${ARTIFACT_SCRIPT_DIGEST_META_NAME} -->`);
      expect(extractArtifactDigestMarkers(withComment)).toMatchObject({ ok: false, code: 'MARKER_DUPLICATE' });
    });

    it('the reserved style name reappears inside an attribute value', async () => {
      const body = await ingestValidArtifact(buildArtifactHtml({}));
      const withAttr = body.replace('<p>', `<p data-x="${ARTIFACT_STYLE_DIGEST_META_NAME}">`);
      expect(extractArtifactDigestMarkers(withAttr)).toMatchObject({ ok: false, code: 'MARKER_DUPLICATE' });
    });

    it('the reserved script name reappears verbatim as body text', async () => {
      const body = await ingestValidArtifact(buildArtifactHtml({}));
      const withText = body.replace('</body>', `<p>${ARTIFACT_SCRIPT_DIGEST_META_NAME}</p></body>`);
      expect(extractArtifactDigestMarkers(withText)).toMatchObject({ ok: false, code: 'MARKER_DUPLICATE' });
    });
  });

  describe('P-3: MARKER_MALFORMED', () => {
    it('attribute order swapped (name before content)', async () => {
      const body = await ingestValidArtifact(buildArtifactHtml({ scripts: ['console.log(1)'] }));
      const swapped = body.replace(
        new RegExp(`<meta content="([^"]*)" name="${ARTIFACT_SCRIPT_DIGEST_META_NAME}">`),
        `<meta name="${ARTIFACT_SCRIPT_DIGEST_META_NAME}" content="$1">`,
      );
      expect(extractArtifactDigestMarkers(swapped)).toMatchObject({ ok: false, code: 'MARKER_MALFORMED' });
    });

    it('script and style markers reversed in order', async () => {
      const body = await ingestValidArtifact(buildArtifactHtml({ scripts: ['console.log(1)'], styles: ['a{color:red}'] }));
      const scriptTag = body.match(new RegExp(`<meta content="[^"]*" name="${ARTIFACT_SCRIPT_DIGEST_META_NAME}">`))?.[0];
      const styleTag = body.match(new RegExp(`<meta content="[^"]*" name="${ARTIFACT_STYLE_DIGEST_META_NAME}">`))?.[0];
      expect(scriptTag).toBeDefined();
      expect(styleTag).toBeDefined();
      const reversed = body.replace(`${scriptTag}${styleTag}`, `${styleTag}${scriptTag}`);
      expect(extractArtifactDigestMarkers(reversed)).toMatchObject({ ok: false, code: 'MARKER_MALFORMED' });
    });

    it('an extra node sits between the two markers', async () => {
      const body = await ingestValidArtifact(buildArtifactHtml({ scripts: ['console.log(1)'], styles: ['a{color:red}'] }));
      const injected = body.replace(
        new RegExp(`(<meta content="[^"]*" name="${ARTIFACT_SCRIPT_DIGEST_META_NAME}">)(<meta content="[^"]*" name="${ARTIFACT_STYLE_DIGEST_META_NAME}">)`),
        '$1<meta charset="utf-8">$2',
      );
      expect(extractArtifactDigestMarkers(injected)).toMatchObject({ ok: false, code: 'MARKER_MALFORMED' });
    });

    it('an extra node sits between the style marker and </head>', async () => {
      const body = await ingestValidArtifact(buildArtifactHtml({}));
      const injected = body.replace(new RegExp(`(<meta content="[^"]*" name="${ARTIFACT_STYLE_DIGEST_META_NAME}">)</head>`), '$1<meta charset="utf-8"></head>');
      expect(extractArtifactDigestMarkers(injected)).toMatchObject({ ok: false, code: 'MARKER_MALFORMED' });
    });

    it('a stray double quote is embedded in the script marker content', async () => {
      const body = await ingestValidArtifact(buildArtifactHtml({ scripts: ['console.log(1)'] }));
      const OPEN = '<meta content="';
      const openIndex = body.indexOf(OPEN);
      const injected = `${body.slice(0, openIndex + OPEN.length)}"${body.slice(openIndex + OPEN.length)}`;
      expect(extractArtifactDigestMarkers(injected)).toMatchObject({ ok: false, code: 'MARKER_MALFORMED' });
    });

    it('a stray "<" is embedded in the style marker content', async () => {
      const body = await ingestValidArtifact(buildArtifactHtml({ styles: ['a{color:red}'] }));
      const OPEN = `<meta content="`;
      const styleOpenIndex = body.lastIndexOf(OPEN, body.indexOf(ARTIFACT_STYLE_DIGEST_META_NAME));
      const injected = `${body.slice(0, styleOpenIndex + OPEN.length)}<${body.slice(styleOpenIndex + OPEN.length)}`;
      expect(extractArtifactDigestMarkers(injected)).toMatchObject({ ok: false, code: 'MARKER_MALFORMED' });
    });
  });
});

// ---------------------------------------------------------------------------
// parseArtifactDigestContent / buildArtifactContentSecurityPolicy — §G 表 / §D 表
// ---------------------------------------------------------------------------

describe('parseArtifactDigestContent', () => {
  const VALID_TOKEN = `sha256-${'A'.repeat(43)}=`;

  it('an empty string parses to an empty token list (0 inline scripts/styles)', () => {
    expect(parseArtifactDigestContent('')).toEqual([]);
  });

  it('a single valid token parses to a 1-element list', () => {
    expect(parseArtifactDigestContent(VALID_TOKEN)).toEqual([VALID_TOKEN]);
  });

  it('multiple valid tokens space-joined parse to a multi-element list', () => {
    const other = `sha256-${'B'.repeat(43)}=`;
    expect(parseArtifactDigestContent(`${VALID_TOKEN} ${other}`)).toEqual([VALID_TOKEN, other]);
  });

  it.each([
    ['a tab between tokens', `${VALID_TOKEN}\t${VALID_TOKEN}`],
    ['a double space between tokens', `${VALID_TOKEN}  ${VALID_TOKEN}`],
    ['leading whitespace', ` ${VALID_TOKEN}`],
    ['trailing whitespace', `${VALID_TOKEN} `],
    ['a CR', `${VALID_TOKEN}\r`],
    ['a LF', `${VALID_TOKEN}\n`],
    ['base64url characters (- and _)', `sha256-${'A'.repeat(41)}-_=`],
    ['42 characters (one short)', `sha256-${'A'.repeat(42)}=`],
    ['44 characters (one long)', `sha256-${'A'.repeat(44)}=`],
    ['an uppercase algorithm name (SHA256)', `SHA256-${'A'.repeat(43)}=`],
    ['a single quote', `sha256-${'A'.repeat(42)}'=`],
    ['a double quote', `sha256-${'A'.repeat(42)}"=`],
    ['a semicolon', `sha256-${'A'.repeat(42)};=`],
    ['a "<"', `sha256-${'A'.repeat(42)}<=`],
  ])('%s is rejected (returns null)', (_label, content) => {
    expect(parseArtifactDigestContent(content)).toBeNull();
  });
});

describe('buildArtifactContentSecurityPolicy', () => {
  it('P-5: DELIVERY_DISABLED when snapshot.deliveryMode is disabled', () => {
    const result = buildArtifactContentSecurityPolicy({ scriptDigests: '', styleDigests: '' }, DISABLED_SNAPSHOT);
    expect(result).toEqual({ ok: false, code: 'DELIVERY_DISABLED', message: ARTIFACT_POLICY_ERROR_MESSAGES.DELIVERY_DISABLED });
  });

  describe('P-4: DIGEST_TOKEN_INVALID', () => {
    it('an invalid script marker content is rejected even when the style marker is empty', () => {
      const result = buildArtifactContentSecurityPolicy({ scriptDigests: 'not-a-token', styleDigests: '' }, MODE_A_SNAPSHOT(false));
      expect(result).toEqual({ ok: false, code: 'DIGEST_TOKEN_INVALID', message: ARTIFACT_POLICY_ERROR_MESSAGES.DIGEST_TOKEN_INVALID });
    });

    it('an invalid style marker content is rejected even when the script marker is empty', () => {
      const result = buildArtifactContentSecurityPolicy({ scriptDigests: '', styleDigests: 'not-a-token' }, MODE_A_SNAPSHOT(false));
      expect(result).toEqual({ ok: false, code: 'DIGEST_TOKEN_INVALID', message: ARTIFACT_POLICY_ERROR_MESSAGES.DIGEST_TOKEN_INVALID });
    });
  });

  describe('§D 表 — golden strings from real ingest output, exact match', () => {
    const CASES: { label: string; scripts: string[]; styles: string[] }[] = [
      { label: '(0,0)', scripts: [], styles: [] },
      { label: '(1,0)', scripts: ['console.log(0);'], styles: [] },
      { label: '(0,1)', scripts: [], styles: ['.a{color:red}'] },
      { label: '(2,3)', scripts: ['console.log(0);', 'console.log(1);'], styles: ['.a{color:red}', '.b{color:blue}', '.c{color:green}'] },
    ];

    it.each(
      CASES.flatMap((c) => [
        { ...c, mode: 'A' as const, font: false },
        { ...c, mode: 'A' as const, font: true },
        { ...c, mode: 'B' as const, font: false },
        { ...c, mode: 'B' as const, font: true },
      ]),
    )('$label x Mode $mode x font=$font', async ({ scripts, styles, mode, font }) => {
      const body = await ingestValidArtifact(buildArtifactHtml({ scripts, styles }));
      const extracted = extractArtifactDigestMarkers(body);
      expect(extracted.ok).toBe(true);
      if (!extracted.ok) return;

      const snapshot = mode === 'A' ? MODE_A_SNAPSHOT(font) : MODE_B_SNAPSHOT(font);
      const result = buildArtifactContentSecurityPolicy(extracted.markers, snapshot);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const scriptTokens = scripts.map(sha256Token);
      const styleTokens = styles.map(sha256Token);
      const scriptSrc = scriptTokens.length === 0 ? "script-src 'none'" : `script-src ${scriptTokens.map((t) => `'${t}'`).join(' ')}`;
      let styleSrc: string;
      if (styleTokens.length === 0) {
        styleSrc = font ? `style-src ${GOOGLE_FONTS_STYLE_ORIGIN}` : "style-src 'none'";
      } else {
        styleSrc = `style-src ${styleTokens.map((t) => `'${t}'`).join(' ')}${font ? ` ${GOOGLE_FONTS_STYLE_ORIGIN}` : ''}`;
      }

      const expected = [
        "default-src 'none'",
        scriptSrc,
        styleSrc,
        'img-src data: blob:',
        ...(font ? [`font-src ${GOOGLE_FONTS_FONT_ORIGIN}`] : []),
        "connect-src 'none'",
        `frame-ancestors ${snapshot.crowiOrigin}`,
        "form-action 'none'",
        "base-uri 'none'",
        'sandbox allow-scripts',
      ].join('; ');

      expect(result.header).toBe(expected);
      // D-10: sandbox is unconditional — present in both Mode A and Mode B.
      expect(result.header.endsWith('sandbox allow-scripts')).toBe(true);
    });
  });

  it('AC-DP-8: builder places script/style tokens only in their own directive (no cross-contamination)', async () => {
    const scriptText = 'console.log("only-in-script-src")';
    const styleText = '.only-in-style-src{color:red}';
    const body = await ingestValidArtifact(buildArtifactHtml({ scripts: [scriptText], styles: [styleText] }));
    const extracted = extractArtifactDigestMarkers(body);
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    const result = buildArtifactContentSecurityPolicy(extracted.markers, MODE_A_SNAPSHOT(false));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const scriptDirective = result.header.split('; ').find((d) => d.startsWith('script-src'));
    const styleDirective = result.header.split('; ').find((d) => d.startsWith('style-src'));
    expect(scriptDirective).toContain(sha256Token(scriptText));
    expect(scriptDirective).not.toContain(sha256Token(styleText));
    expect(styleDirective).toContain(sha256Token(styleText));
    expect(styleDirective).not.toContain(sha256Token(scriptText));
  });
});
