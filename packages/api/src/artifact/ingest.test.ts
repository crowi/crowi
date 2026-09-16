import {
  ingestHtmlArtifact,
  parseArtifactDocument,
  loadParse5Runtime,
  createCountingTreeAdapter,
  getArtifactBudgetClasses,
  countTreeBudget,
  serializeArtifactTree,
  scanCssText,
  ARTIFACT_INGEST_RULES,
  ARTIFACT_NODE_BUDGET,
  ARTIFACT_MAX_TREE_DEPTH,
  ARTIFACT_MAX_ATTRIBUTES_PER_ELEMENT,
  ARTIFACT_MAX_TOTAL_ATTRIBUTES,
  ARTIFACT_CSS_MAX_BYTES,
  ARTIFACT_CSS_MAX_TOKENS,
  ArtifactNodeBudgetExceeded,
  artifactParserSeam,
  type ArtifactIngestOptions,
  type ArtifactIngestResult,
  type ArtifactRuleContext,
} from './ingest';
import { ARTIFACT_HARD_MAX_BYTES, ARTIFACT_MIN_MAX_BYTES, ARTIFACT_SCRIPT_DIGEST_META_NAME, ARTIFACT_STYLE_DIGEST_META_NAME } from './constants';
import { validArtifactHtml, VALID_ARTIFACT_HTML } from '../test/artifact-fixtures';

const SCRIPT_MARKER_NAME = ARTIFACT_SCRIPT_DIGEST_META_NAME;
const STYLE_MARKER_NAME = ARTIFACT_STYLE_DIGEST_META_NAME;

function authorOptions(overrides?: Partial<ArtifactIngestOptions>): ArtifactIngestOptions {
  return { source: 'author', allowWebFonts: false, maxBytes: 2 * 1024 * 1024, ...overrides };
}

function storedOptions(overrides?: Partial<ArtifactIngestOptions>): ArtifactIngestOptions {
  return { source: 'stored-revision', allowWebFonts: false, maxBytes: 2 * 1024 * 1024, ...overrides };
}

function expectAccepted(result: ArtifactIngestResult): asserts result is ArtifactIngestResult & { ok: true } {
  if (!result.ok) {
    throw new Error(`expected acceptance, got rejection: ${JSON.stringify(result.rejection)}`);
  }
}

function expectRejected(result: ArtifactIngestResult, ruleId: string, reason?: string): void {
  if (result.ok) {
    throw new Error('expected rejection, got acceptance');
  }
  expect(result.rejection.ruleId).toBe(ruleId);
  if (reason) expect(result.rejection.reason).toBe(reason);
}

async function ingestValid(overrides?: Readonly<{ script?: string; style?: string; body?: string }>, options?: Partial<ArtifactIngestOptions>) {
  return ingestHtmlArtifact(validArtifactHtml(overrides), authorOptions(options));
}

/**
 * A whitespace-free skeleton — no text ever appears between `<head>` and
 * `<body>` or between markup children — so its node count is exactly
 * doctype+html+head+body = 4 in the source pass, +2 for the reserved
 * digest markers in the normalized pass. `validArtifactHtml`'s template
 * literal is not used for the exact resource-limit boundaries below: its
 * embedded newlines land differently depending on HTML5's insertion mode
 * at each point (some ignored, some inserted as text), which makes the
 * skeleton's own node count non-obvious to derive by hand.
 */
function skeletonHtml(body: string): string {
  return `<!doctype html><html><head></head><body>${body}</body></html>`;
}

const MARKER_ATTRIBUTE_COUNT = 4; // the 2 reserved markers, `name` + `content` each.

function words(n: number): string {
  return Array.from({ length: n }, () => 'a').join(' ');
}

describe('ingestHtmlArtifact', () => {
  describe('AC-AI-1: normalization, digest markers, round-trip', () => {
    it('normalizes a valid author document to canonical bytes with digest markers', async () => {
      const result = await ingestValid();
      expectAccepted(result);
      const text = Buffer.from(result.bytes).toString('utf8');
      expect(text.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(result.scriptDigests).toHaveLength(1);
      expect(result.styleDigests).toHaveLength(1);
      expect(result.scriptDigests[0]).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
      expect(result.styleDigests[0]).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);

      const expectedTail = `<meta content="${result.scriptDigests.join(' ')}" name="${SCRIPT_MARKER_NAME}"><meta content="${result.styleDigests.join(' ')}" name="${STYLE_MARKER_NAME}"></head>`;
      expect(text).toContain(expectedTail);
    });

    it('computes the same hash a browser would (SHA-256 of the concatenated child Text of each inline script/style)', async () => {
      const script = "console.log('hello')";
      const style = 'body{color:red}';
      const result = await ingestValid({ script, style });
      expectAccepted(result);
      const crypto = await import('node:crypto');
      const expectedScript = `sha256-${crypto.createHash('sha256').update(Buffer.from(script, 'utf8')).digest('base64')}`;
      const expectedStyle = `sha256-${crypto.createHash('sha256').update(Buffer.from(style, 'utf8')).digest('base64')}`;
      expect(result.scriptDigests).toEqual([expectedScript]);
      expect(result.styleDigests).toEqual([expectedStyle]);
    });

    it('places an empty-content marker for a kind with zero inline elements', async () => {
      const html = '<!doctype html><html><head><meta charset="utf-8"><style>a{color:red}</style></head><body>x</body></html>';
      const result = await ingestHtmlArtifact(html, authorOptions());
      expectAccepted(result);
      expect(result.scriptDigests).toEqual([]);
      const text = Buffer.from(result.bytes).toString('utf8');
      expect(text).toContain(`<meta content="" name="${SCRIPT_MARKER_NAME}">`);
    });

    it('round-trips: fetching the stored bytes back and re-ingesting as stored-revision produces identical bytes', async () => {
      const first = await ingestValid();
      expectAccepted(first);
      const roundTripInput = Buffer.from(first.bytes).toString('utf8');
      const second = await ingestHtmlArtifact(roundTripInput, storedOptions());
      expectAccepted(second);
      expect(Buffer.from(second.bytes)).toEqual(Buffer.from(first.bytes));
    });

    it('the encode is reversible: TextDecoder(bytes) === serialized', async () => {
      const result = await ingestValid();
      expectAccepted(result);
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(result.bytes);
      expect(Buffer.from(decoded, 'utf8')).toEqual(Buffer.from(result.bytes));
    });

    it('preserves a real leading newline inside <pre> across serialize/reparse (and is not doubled)', async () => {
      const body = '<pre>\n\nreal-newline-preserved</pre>';
      const result = await ingestValid({ body });
      expectAccepted(result);
      const text = Buffer.from(result.bytes).toString('utf8');
      // The parser eats exactly one leading LF after <pre>; our own
      // serializer must add exactly one back so a reparse recovers the
      // second (real) newline without growing on every round trip.
      expect(text).toContain('<pre>\n\nreal-newline-preserved</pre>');
      const again = await ingestHtmlArtifact(text, storedOptions());
      expectAccepted(again);
      expect(Buffer.from(again.bytes)).toEqual(Buffer.from(result.bytes));
    });

    it('loadParse5Runtime loads parse5 8 under the jest server project without ERR_REQUIRE_ESM', () => {
      const runtime = loadParse5Runtime();
      expect(typeof runtime.parse).toBe('function');
      expect(typeof runtime.serialize).toBe('function');
      expect(typeof runtime.defaultTreeAdapter).toBe('object');
      expect(typeof runtime.ErrorCodes).toBe('object');
      expect(typeof runtime.Parser).toBe('function');
      expect(typeof runtime.Tokenizer).toBe('function');
    });

    it.each(['textarea', 'listing'])('preserves a real leading newline inside <%s> across serialize/reparse (and is not doubled)', async (tag) => {
      const body = `<${tag}>\n\nreal-newline-preserved</${tag}>`;
      const result = await ingestValid({ body });
      expectAccepted(result);
      const text = Buffer.from(result.bytes).toString('utf8');
      expect(text).toContain(`<${tag}>\n\nreal-newline-preserved</${tag}>`);
      const again = await ingestHtmlArtifact(text, storedOptions());
      expectAccepted(again);
      expect(Buffer.from(again.bytes)).toEqual(Buffer.from(result.bytes));
    });

    it('AI-R22 rejects when the reparsed tree does not reserialize back to the exact text it was parsed from', async () => {
      const parsed = parseArtifactDocument(VALID_ARTIFACT_HTML, 'normalized');
      if (!('document' in parsed)) throw new Error('expected a parsed document');
      const rule = ARTIFACT_INGEST_RULES.find((r) => r.id === 'AI-R22')!;
      const context: ArtifactRuleContext = {
        pass: 'normalized',
        source: 'author',
        input: 'this is not what serializeArtifactTree(parsed.document) will produce',
        options: authorOptions(),
        parsed,
        ownership: { exemptReservedMarker: true },
      };
      const failure = await rule.check(context, rule);
      expect(failure).not.toBeNull();
    });

    it('AI-R22 accepts when the reparsed tree reserializes back to the exact text it was parsed from', async () => {
      const parsed = parseArtifactDocument(VALID_ARTIFACT_HTML, 'normalized');
      if (!('document' in parsed)) throw new Error('expected a parsed document');
      const rule = ARTIFACT_INGEST_RULES.find((r) => r.id === 'AI-R22')!;
      const context: ArtifactRuleContext = {
        pass: 'normalized',
        source: 'author',
        input: serializeArtifactTree(parsed.document),
        options: authorOptions(),
        parsed,
        ownership: { exemptReservedMarker: true },
      };
      const failure = await rule.check(context, rule);
      expect(failure).toBeNull();
    });
  });

  describe('AC-AI-2: rule table shape and marker ownership', () => {
    it('every rule row declares non-empty passes/sources and explicit ownedExemptions/priority', () => {
      for (const rule of ARTIFACT_INGEST_RULES) {
        expect(rule.passes.length).toBeGreaterThan(0);
        expect(rule.sources.length).toBeGreaterThan(0);
        expect(Array.isArray(rule.ownedExemptions)).toBe(true);
        expect(typeof rule.priority).toBe('number');
      }
    });

    it('AI-R09 and AI-R12 apply to both sources and (where relevant) both parsed passes', () => {
      const r09 = ARTIFACT_INGEST_RULES.find((r) => r.id === 'AI-R09')!;
      const r12 = ARTIFACT_INGEST_RULES.find((r) => r.id === 'AI-R12')!;
      expect(r09.passes).toEqual(expect.arrayContaining(['source', 'normalized']));
      expect(r09.sources).toEqual(expect.arrayContaining(['author', 'stored-revision']));
      expect(r12.passes).toEqual(expect.arrayContaining(['source', 'normalized']));
      expect(r12.sources).toEqual(expect.arrayContaining(['author', 'stored-revision']));
      expect(r09.ownedExemptions).toEqual([{ kind: 'normalizer-marker' }]);
    });

    it('rejects a stored marker with an extra attribute (source pass)', async () => {
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta content="" name="${SCRIPT_MARKER_NAME}" onclick="x"><meta content="" name="${STYLE_MARKER_NAME}"></head><body>x</body></html>`;
      const result = await ingestHtmlArtifact(html, storedOptions());
      expectRejected(result, 'AI-R21', 'NORMALIZER_MARKER_INVALID');
    });

    it('rejects duplicate reserved-name markers at head (source pass)', async () => {
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta content="" name="${SCRIPT_MARKER_NAME}"><meta content="" name="${SCRIPT_MARKER_NAME}"><meta content="" name="${STYLE_MARKER_NAME}"></head><body>x</body></html>`;
      const result = await ingestHtmlArtifact(html, storedOptions());
      expectRejected(result, 'AI-R21', 'NORMALIZER_MARKER_INVALID');
    });

    it('a well-formed head-direct marker pair is stripped and recomputed without rejection', async () => {
      const first = await ingestValid();
      expectAccepted(first);
      const roundTripInput = Buffer.from(first.bytes).toString('utf8');
      const second = await ingestHtmlArtifact(roundTripInput, storedOptions());
      expectAccepted(second);
    });

    it('does not strip a reserved-name meta placed inside <body> — AI-R09 rejects it', async () => {
      const body = `<meta content="" name="${SCRIPT_MARKER_NAME}">`;
      const result = await ingestValid({ body });
      expectRejected(result, 'AI-R09', 'META_FORBIDDEN');
    });

    it('does not strip a reserved-name meta placed inside <template> content — AI-R09 rejects it', async () => {
      const body = `<template><meta content="" name="${SCRIPT_MARKER_NAME}"></template>`;
      const result = await ingestValid({ body });
      expectRejected(result, 'AI-R09', 'META_FORBIDDEN');
    });

    it('rejects a document containing the reserved marker literal outside the marker itself', async () => {
      const script = `const x = '${SCRIPT_MARKER_NAME}';`;
      const result = await ingestValid({ script });
      expectRejected(result, 'AI-R21', 'NORMALIZER_MARKER_INVALID');
    });

    it('a source-pass marker with only a `name` attribute (no `content`) is a valid subset shape — stripped and recomputed, not rejected', async () => {
      // AI-R21's source pass requires the removed marker's attribute names
      // to be a *subset* of {name, content}, not exactly {name, content} —
      // whatever content it carried is discarded and recomputed in step 5
      // regardless, so a marker missing `content` entirely is still a
      // valid position/shape to strip.
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="${SCRIPT_MARKER_NAME}"><meta content="" name="${STYLE_MARKER_NAME}"></head><body>x</body></html>`;
      const result = await ingestHtmlArtifact(html, storedOptions());
      expectAccepted(result);
    });

    it('AI-R21 (normalized pass, hand-crafted): rejects a marker whose content does not match the recomputed digest', async () => {
      // A tampered digest can never survive a real `ingestHtmlArtifact`
      // call (normalization always recomputes and overwrites marker
      // content in step 5), so this drives the rule directly against a
      // hand-crafted "already normalized" document to prove the check
      // itself — not just the normalizer that makes it unreachable in
      // practice — rejects a mismatch.
      const valid = await ingestValid({ script: "console.log('mismatch-fixture')" });
      expectAccepted(valid);
      const text = Buffer.from(valid.bytes).toString('utf8');
      const tampered = text.replace(
        new RegExp(`<meta content="[^"]*" name="${SCRIPT_MARKER_NAME}">`),
        `<meta content="sha256-0000000000000000000000000000000000000000A=" name="${SCRIPT_MARKER_NAME}">`,
      );
      expect(tampered).not.toEqual(text);
      const parsed = parseArtifactDocument(tampered, 'normalized');
      if (!('document' in parsed)) throw new Error('expected a parsed document');
      const rule = ARTIFACT_INGEST_RULES.find((r) => r.id === 'AI-R21')!;
      const context: ArtifactRuleContext = {
        pass: 'normalized',
        source: 'stored-revision',
        input: tampered,
        options: storedOptions(),
        parsed,
        ownership: { exemptReservedMarker: true },
      };
      const failure = await rule.check(context, rule);
      expect(failure).not.toBeNull();
    });
  });

  describe('AC-AI-3: doctype / document structure / newline+BOM normalization', () => {
    it('rejects a document with a parse error unrelated to doctype', async () => {
      const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><table><tr><td>x</td></tr></table><</body></html>';
      const result = await ingestHtmlArtifact(html, authorOptions());
      expectRejected(result, 'AI-R03', 'HTML_PARSE_ERROR');
    });

    it('rejects a missing doctype as DOCTYPE_INVALID (not HTML_PARSE_ERROR)', async () => {
      const html = '<html><head><meta charset="utf-8"></head><body>x</body></html>';
      const result = await ingestHtmlArtifact(html, authorOptions());
      expectRejected(result, 'AI-R04', 'DOCTYPE_INVALID');
    });

    it('rejects a non-html doctype name', async () => {
      const html = '<!doctype foo><html><head><meta charset="utf-8"></head><body>x</body></html>';
      const result = await ingestHtmlArtifact(html, authorOptions());
      expectRejected(result, 'AI-R04', 'DOCTYPE_INVALID');
    });

    it('accepts a duplicated body/html and an implicit-root document (parse5 silently normalizes)', async () => {
      const html = '<!doctype html><p>just a paragraph</p>';
      const result = await ingestHtmlArtifact(html, authorOptions());
      expectAccepted(result);
    });

    it('accepts whitespace and comments between </head> and <body>, and after </html>', async () => {
      const html = '<!doctype html><html><head><meta charset="utf-8"></head>\n<body>x</body></html><!-- trailing -->';
      const result = await ingestHtmlArtifact(html, authorOptions());
      expectAccepted(result);
    });

    it('rejects a frameset document (html child is neither head nor body)', async () => {
      // parse5's error recovery always re-homes stray top-level text/element
      // content into <body> (verified empirically — there is no HTML5-legal
      // input that leaves a stray element/non-whitespace-text node directly
      // under <html> or <document>), so the only *reachable* violation of
      // "html's children are head/body/whitespace/comment only" is a
      // frameset document, which replaces <body> with <frameset> and
      // produces no parse error at all.
      const html = '<!doctype html><html><head><meta charset="utf-8"></head><frameset><frame></frameset></html>';
      const result = await ingestHtmlArtifact(html, authorOptions());
      expectRejected(result, 'AI-R05', 'DOCUMENT_STRUCTURE_INVALID');
    });

    it('a second doctype right after <html> is misplaced-doctype -> DOCTYPE_INVALID', async () => {
      const html = '<!doctype html><html><!doctype html><head><meta charset="utf-8"></head><body>x</body></html>';
      const result = await ingestHtmlArtifact(html, authorOptions());
      expectRejected(result, 'AI-R04', 'DOCTYPE_INVALID');
    });

    it('normalizes CRLF and lone CR to LF', async () => {
      const html = validArtifactHtml().replace(/\n/g, '\r\n');
      const result = await ingestHtmlArtifact(html, authorOptions());
      expectAccepted(result);
      const text = Buffer.from(result.bytes).toString('utf8');
      expect(text.includes('\r')).toBe(false);
    });

    it('strips exactly one leading BOM and accepts the document', async () => {
      const html = `\uFEFF${VALID_ARTIFACT_HTML}`;
      const result = await ingestHtmlArtifact(html, authorOptions());
      expectAccepted(result);
    });

    it('a second BOM is left as an ordinary character and breaks the doctype', async () => {
      const html = `\uFEFF\uFEFF${VALID_ARTIFACT_HTML}`;
      const result = await ingestHtmlArtifact(html, authorOptions());
      expectRejected(result, 'AI-R04', 'DOCTYPE_INVALID');
    });
  });

  describe('AC-AI-4: forbidden elements / attributes / meta matrix', () => {
    it.each(['base', 'iframe', 'object', 'embed', 'portal', 'noscript'])('rejects forbidden element <%s>', async (tag) => {
      const body = `<${tag}></${tag}>`;
      const result = await ingestValid({ body });
      expectRejected(result, 'AI-R07', 'ELEMENT_FORBIDDEN');
    });

    it('a bare <frame>/<frameset> inside body content is dropped by parse5 itself (no node, no parse error) — nothing to reject and nothing rendered', async () => {
      const result = await ingestValid({ body: '<frame></frame>' });
      expectAccepted(result);
    });

    it('rejects forbidden elements nested inside <template> content', async () => {
      const body = '<template><iframe></iframe></template>';
      const result = await ingestValid({ body });
      expectRejected(result, 'AI-R07', 'ELEMENT_FORBIDDEN');
    });

    it.each(['onclick', 'ONCLICK', 'OnClick', 'style', 'srcdoc', 'ping', 'manifest', 'referrerpolicy'])('rejects forbidden attribute %s', async (attr) => {
      const body = `<div ${attr}="x"></div>`;
      const result = await ingestValid({ body });
      expectRejected(result, 'AI-R08', 'ATTRIBUTE_FORBIDDEN');
    });

    it.each(['utf-8', 'UTF-8', 'utf8'])('accepts charset meta value %s', async (value) => {
      const html = `<!doctype html><html><head><meta charset="${value}"></head><body>x</body></html>`;
      const result = await ingestHtmlArtifact(html, authorOptions());
      expectAccepted(result);
    });

    it('rejects a non-utf-8 charset', async () => {
      const html = '<!doctype html><html><head><meta charset="Shift_JIS"></head><body>x</body></html>';
      const result = await ingestHtmlArtifact(html, authorOptions());
      expectRejected(result, 'AI-R09', 'META_FORBIDDEN');
    });

    it('accepts a well-formed viewport meta and rejects http-equiv', async () => {
      const ok = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body>x</body></html>';
      expectAccepted(await ingestHtmlArtifact(ok, authorOptions()));

      const bad = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0"></head><body>x</body></html>';
      expectRejected(await ingestHtmlArtifact(bad, authorOptions()), 'AI-R09', 'META_FORBIDDEN');
    });

    it('a head-direct reserved-name meta sent by the author is stripped, not treated as a forbidden meta', async () => {
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta content="" name="${SCRIPT_MARKER_NAME}"><meta content="" name="${STYLE_MARKER_NAME}"></head><body>x</body></html>`;
      const result = await ingestHtmlArtifact(html, authorOptions());
      expectAccepted(result);
    });

    it.each(['form', 'input'])('<%s> is not a globally forbidden element (AI-R07) — only its URL-bearing attributes are constrained (AI-R11)', async (tag) => {
      const result = await ingestValid({ body: `<${tag}></${tag}>` });
      expectAccepted(result);
    });
  });

  describe('AC-AI-5: URL attribute matrix', () => {
    it.each([
      ['relative', 'a.png'],
      ['protocol-relative', '//evil.example/a.png'],
      ['http', 'http://evil.example/a.png'],
      ['javascript', "javascript:alert('x')"],
    ])('rejects %s img[src]', async (_label, value) => {
      const body = `<img src="${value}">`;
      const result = await ingestValid({ body });
      expectRejected(result, 'AI-R11', 'EXTERNAL_REFERENCE');
    });

    it('accepts data:image/* img[src] and video[poster], rejects blob: and non-image data: MIME types', async () => {
      const ok = await ingestValid({ body: '<img src="data:image/png;base64,AAAA">' });
      expectAccepted(ok);
      const posterOk = await ingestValid({ body: '<video poster="data:image/png;base64,AAAA"></video>' });
      expectAccepted(posterOk);
      const blob = await ingestValid({ body: '<img src="blob:https://example.com/uuid">' });
      expectRejected(blob, 'AI-R11', 'EXTERNAL_REFERENCE');
      const notImage = await ingestValid({ body: '<img src="data:text/html,<script>1</script>">' });
      expectRejected(notImage, 'AI-R11', 'EXTERNAL_REFERENCE');
      const posterNotImage = await ingestValid({ body: '<video poster="data:text/html,hi"></video>' });
      expectRejected(posterNotImage, 'AI-R11', 'EXTERNAL_REFERENCE');
    });

    it('accepts a[href] fragment and rejects a[href] external', async () => {
      const ok = await ingestValid({ body: '<a href="#section">x</a>' });
      expectAccepted(ok);
      const bad = await ingestValid({ body: '<a href="https://evil.example/">x</a>' });
      expectRejected(bad, 'AI-R11', 'EXTERNAL_REFERENCE');
    });

    it('rejects script[src] and form[action] regardless of scheme', async () => {
      const script = await ingestValid({ body: '<script src="data:text/javascript,1"></script>' });
      expectRejected(script, 'AI-R11', 'EXTERNAL_REFERENCE');
      const form = await ingestValid({ body: '<form action="#ok"></form>' });
      expectRejected(form, 'AI-R11', 'EXTERNAL_REFERENCE');
    });

    it('SVG href/xlink:href allow only same-document fragments (use/textPath/linearGradient/pattern/animate/mpath/a)', async () => {
      const svgBody = `<svg xmlns="http://www.w3.org/2000/svg">
        <linearGradient id="g"><stop offset="0"/></linearGradient>
        <use href="#g"/>
        <a xlink:href="#g"><text>x</text></a>
      </svg>`;
      const ok = await ingestValid({ body: svgBody });
      expectAccepted(ok);

      const bad = await ingestValid({ body: '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/x.svg#g"/></svg>' });
      expectRejected(bad, 'AI-R11', 'EXTERNAL_REFERENCE');
    });

    it('SVG image[href] allows data:image/* only (not fragment, not other data: MIME types); SVG script[href] is always rejected', async () => {
      const dataImage = await ingestValid({ body: '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AAAA"/></svg>' });
      expectAccepted(dataImage);

      const fragImage = await ingestValid({ body: '<svg xmlns="http://www.w3.org/2000/svg"><image href="#g"/></svg>' });
      expectRejected(fragImage, 'AI-R11', 'EXTERNAL_REFERENCE');

      const notImage = await ingestValid({ body: '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:text/html,hi"/></svg>' });
      expectRejected(notImage, 'AI-R11', 'EXTERNAL_REFERENCE');

      const scriptHref = await ingestValid({ body: '<svg xmlns="http://www.w3.org/2000/svg"><script href="#g"/></svg>' });
      expectRejected(scriptHref, 'AI-R11', 'EXTERNAL_REFERENCE');
    });

    it('MathML href allows fragment only; definitionURL is always rejected', async () => {
      const ok = await ingestValid({ body: '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi href="#x">a</mi></math>' });
      expectAccepted(ok);
      const bad = await ingestValid({ body: '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi href="https://evil.example">a</mi></math>' });
      expectRejected(bad, 'AI-R11', 'EXTERNAL_REFERENCE');
      const definitionUrl = await ingestValid({ body: '<math xmlns="http://www.w3.org/1998/Math/MathML" definitionurl="https://evil.example"></math>' });
      expectRejected(definitionUrl, 'AI-R11', 'EXTERNAL_REFERENCE');
    });

    it('rejects xml:base on both SVG and HTML elements', async () => {
      const svg = await ingestValid({ body: '<svg xmlns="http://www.w3.org/2000/svg"><a xml:base="https://evil.example/">x</a></svg>' });
      expectRejected(svg, 'AI-R11a', 'EXTERNAL_REFERENCE');
      const html = await ingestValid({ body: '<div xml:base="https://evil.example/"></div>' });
      expectRejected(html, 'AI-R11a', 'EXTERNAL_REFERENCE');
    });

    it('SVG animate attributeName=href: values list allows fragments, rejects an external/data entry', async () => {
      const ok = await ingestValid({
        body: '<svg xmlns="http://www.w3.org/2000/svg"><rect><set attributeName="href" to="#a"/></rect></svg>',
      });
      expectAccepted(ok);
      const bad = await ingestValid({
        body: '<svg xmlns="http://www.w3.org/2000/svg"><rect><animate attributeName="href" values="#a;https://evil.example"/></rect></svg>',
      });
      expectRejected(bad, 'AI-R11b', 'EXTERNAL_REFERENCE');
    });

    it('SVG animate attributeName=fill (presentation): url(#g) accepted, url(https://...) rejected, non-url values untouched', async () => {
      const ok = await ingestValid({
        body: '<svg xmlns="http://www.w3.org/2000/svg"><rect><animate attributeName="fill" values="red;blue"/></rect></svg>',
      });
      expectAccepted(ok);
      const bad = await ingestValid({
        body: '<svg xmlns="http://www.w3.org/2000/svg"><rect><animate attributeName="fill" to="url(https://evil.example/x)"/></rect></svg>',
      });
      expectRejected(bad, 'AI-R11b', 'EXTERNAL_REFERENCE');
    });

    it('SVG animate attributeName not in the URL table (e.g. opacity) is not value-checked', async () => {
      const result = await ingestValid({
        body: '<svg xmlns="http://www.w3.org/2000/svg"><rect><animate attributeName="opacity" values="https://not-a-url-check;0"/></rect></svg>',
      });
      expectAccepted(result);
    });

    it('Google Fonts stylesheet link: allowed when allowWebFonts, FONT_REFERENCE_FORBIDDEN otherwise; near-miss host rejected regardless', async () => {
      const body = '<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Roboto">';
      const allowed = await ingestValid({ body }, { allowWebFonts: true });
      expectAccepted(allowed);
      const disallowed = await ingestValid({ body }, { allowWebFonts: false });
      expectRejected(disallowed, 'AI-R12', 'FONT_REFERENCE_FORBIDDEN');

      const nearMiss = await ingestValid({ body: '<link rel="stylesheet" href="https://evil.fonts.googleapis.com/x">' }, { allowWebFonts: true });
      expectRejected(nearMiss, 'AI-R11', 'EXTERNAL_REFERENCE');
    });

    it('AI-R11 exempts a Google Fonts origin link only when rel=stylesheet — a non-stylesheet rel, or no rel at all, is judged as an ordinary link[href]', async () => {
      const wrongRel = await ingestValid({ body: '<link rel="icon" href="https://fonts.googleapis.com/icon.png">' }, { allowWebFonts: true });
      expectRejected(wrongRel, 'AI-R11', 'EXTERNAL_REFERENCE');

      const noRel = await ingestValid({ body: '<link href="https://fonts.googleapis.com/icon.png">' }, { allowWebFonts: true });
      expectRejected(noRel, 'AI-R11', 'EXTERNAL_REFERENCE');
    });

    it('an explicit :443 port is a near-miss even though it equals the HTTPS default (WHATWG URL drops a written default port on parse)', async () => {
      const explicitDefaultPort = await ingestValid(
        { body: '<link rel="stylesheet" href="https://fonts.googleapis.com:443/css?family=Roboto">' },
        { allowWebFonts: true },
      );
      expectRejected(explicitDefaultPort, 'AI-R11', 'EXTERNAL_REFERENCE');

      const cssImportExplicitPort = await ingestValid({ style: "@import url('https://fonts.googleapis.com:443/css?family=Roboto');" }, { allowWebFonts: true });
      expectRejected(cssImportExplicitPort, 'AI-R19', 'URL_FORBIDDEN');
    });

    it('CSS @import near-miss forms (http:, credentials, host suffix, explicit port) are all URL_FORBIDDEN via AI-R19, in both the url() and quoted-string forms, regardless of allowWebFonts', async () => {
      const nearMisses = [
        "url('http://fonts.googleapis.com/css?family=Roboto')",
        "url('https://user:pass@fonts.googleapis.com/css?family=Roboto')",
        "url('https://evil.fonts.googleapis.com/css?family=Roboto')",
        "url('https://fonts.googleapis.com:443/css?family=Roboto')",
        "'http://fonts.googleapis.com/css?family=Roboto'",
        "'https://user:pass@fonts.googleapis.com/css?family=Roboto'",
        "'https://evil.fonts.googleapis.com/css?family=Roboto'",
        "'https://fonts.googleapis.com:443/css?family=Roboto'",
      ];
      for (const target of nearMisses) {
        for (const allowWebFonts of [true, false]) {
          const result = await ingestValid({ style: `@import ${target};` }, { allowWebFonts });
          expectRejected(result, 'AI-R19', 'URL_FORBIDDEN');
        }
      }
    });

    it('AI-R16 still forbids an @import whose target is not itself URL_FORBIDDEN but is not a Google Fonts reference either (e.g. a same-document fragment)', async () => {
      const result = await ingestValid({ style: "@import url('#frag');" });
      expectRejected(result, 'AI-R16', 'CSS_AT_RULE_FORBIDDEN');
    });
  });

  describe('AC-AI-6: script type / module specifiers', () => {
    it.each(['', 'text/javascript', 'application/javascript', 'module'])('accepts inline script type=%s', async (type) => {
      const body = type === '' ? '<script>1;</script>' : `<script type="${type}">1;</script>`;
      const result = await ingestValid({ body });
      expectAccepted(result);
    });

    it.each(['text/babel', 'application/json', 'importmap', 'speculationrules'])('rejects inline script type=%s (closed allowlist)', async (type) => {
      const body = `<script type="${type}">1;</script>`;
      const result = await ingestValid({ body });
      expectRejected(result, 'AI-R13', 'SCRIPT_TYPE_FORBIDDEN');
    });

    it('rejects static import / export-from / dynamic import (string and non-string specifier), allows import.meta', async () => {
      const staticImport = await ingestValid({ script: "import x from './a.js'; console.log(x);" });
      expectRejected(staticImport, 'AI-R14', 'MODULE_SPECIFIER_FORBIDDEN');

      const exportFrom = await ingestValid({ script: "export { x } from './a.js';" });
      expectRejected(exportFrom, 'AI-R14', 'MODULE_SPECIFIER_FORBIDDEN');

      const dynamicString = await ingestValid({ script: "import('./a.js').then(() => {});" });
      expectRejected(dynamicString, 'AI-R14', 'MODULE_SPECIFIER_FORBIDDEN');

      const dynamicExpr = await ingestValid({ script: "import(('./' + 'a.js')).then(() => {});" });
      expectRejected(dynamicExpr, 'AI-R14', 'MODULE_SPECIFIER_FORBIDDEN');

      const meta = await ingestValid({ script: 'console.log(import.meta.url);' });
      expectAccepted(meta);
    });

    it('SVG <script>if(a<g>c){}</script> parses without error and forbids the element-child -> AI-R07a', async () => {
      const body = '<svg xmlns="http://www.w3.org/2000/svg"><script>if(a<g>c){}</script></svg>';
      const result = await ingestValid({ body });
      expectRejected(result, 'AI-R07a', 'INLINE_CODE_CONTENT_INVALID');
    });

    it('SVG <script>if(a<b&&c){}</script> is a tokenizer parse error -> AI-R03', async () => {
      const body = '<svg xmlns="http://www.w3.org/2000/svg"><script>if(a<b&&c){}</script></svg>';
      const result = await ingestValid({ body });
      expectRejected(result, 'AI-R03', 'HTML_PARSE_ERROR');
    });

    it('the equivalent HTML <script> (raw text) accepts the same source verbatim', async () => {
      const result = await ingestValid({ script: 'if(a<g>c){}' });
      expectAccepted(result);
    });

    it('an escaped SVG script (&lt;) is accepted and its digest matches the decoded text', async () => {
      const body = '<svg xmlns="http://www.w3.org/2000/svg"><script>if (a &lt; b) { c(); }</script></svg>';
      const result = await ingestValid({ body });
      expectAccepted(result);
      const crypto = await import('node:crypto');
      const expected = `sha256-${crypto.createHash('sha256').update(Buffer.from('if (a < b) { c(); }', 'utf8')).digest('base64')}`;
      expect(result.scriptDigests).toContain(expected);
    });
  });

  describe('AC-AI-7: CSS parse / at-rule / function / string / url matrix', () => {
    it('rejects malformed CSS without leaking the parser message', async () => {
      const result = await ingestValid({ style: 'a { color: rgb(1,2,3 }' });
      expectRejected(result, 'AI-R15', 'CSS_PARSE_ERROR');
      if (!result.ok) expect(JSON.stringify(result.rejection)).not.toMatch(/Unclosed/i);
    });

    it('rejects an at-rule whose prelude never closes its own parenthesis (PostCSS recovers instead of throwing)', async () => {
      // PostCSS captures the rest of the input verbatim as this at-rule's
      // `params` instead of raising a CssSyntaxError; postcss-value-parser
      // then marks the resulting paren-group node `unclosed: true` rather
      // than throwing.
      const result = await ingestValid({ style: '@media (x {a{color:red}}' });
      expectRejected(result, 'AI-R15', 'CSS_PARSE_ERROR');
    });

    it('rejects an @supports prelude with an unmatched paren swallowing an embedded block, the same way as @media', async () => {
      const result = await ingestValid({ style: '@supports (color: red { a { color: blue; } }' });
      expectRejected(result, 'AI-R15', 'CSS_PARSE_ERROR');
    });

    it('rejects an extra, unmatched closing parenthesis as malformed CSS via the S2 pre-scan, before PostCSS ever runs (neither PostCSS nor value-parser treats it as an error on their own)', async () => {
      const parseStylesheetSpy = jest.spyOn(artifactParserSeam, 'parseStylesheet');
      const parseValueSpy = jest.spyOn(artifactParserSeam, 'parseValue');
      try {
        // Sanity checks on the underlying libraries this test guards against
        // regressing on: neither one raises for a stray `)` — PostCSS parses
        // the declaration/at-rule verbatim, and value-parser hands the extra
        // `)` back as an inert `word` node that no AI-R17/18/19 check
        // inspects, so without the S2 guard both inputs below would be
        // silently accepted instead of rejected as malformed CSS.
        expect(scanCssText('a{p:calc(1px))}').hasUnbalancedClosingParen).toBe(true);
        expect(scanCssText('a{p:foo)}').hasUnbalancedClosingParen).toBe(true);

        parseStylesheetSpy.mockClear();
        parseValueSpy.mockClear();
        const extraCloseInFunction = await ingestValid({ style: 'a{p:calc(1px))}' });
        expectRejected(extraCloseInFunction, 'AI-R15', 'CSS_PARSE_ERROR');
        expect(parseStylesheetSpy).not.toHaveBeenCalled();
        expect(parseValueSpy).not.toHaveBeenCalled();

        parseStylesheetSpy.mockClear();
        parseValueSpy.mockClear();
        const extraCloseBareWord = await ingestValid({ style: 'a{p:foo)}' });
        expectRejected(extraCloseBareWord, 'AI-R15', 'CSS_PARSE_ERROR');
        expect(parseStylesheetSpy).not.toHaveBeenCalled();
        expect(parseValueSpy).not.toHaveBeenCalled();
      } finally {
        parseStylesheetSpy.mockRestore();
        parseValueSpy.mockRestore();
      }
    });

    it('a balanced closing parenthesis anywhere in a selector, declaration, or at-rule params does not trip the unmatched-close guard', async () => {
      expect(scanCssText('a:not(b) { color: red; }').hasUnbalancedClosingParen).toBe(false);
      expect(scanCssText('a:nth-child(2n+1) { color: red; }').hasUnbalancedClosingParen).toBe(false);
      expect(scanCssText('@media (min-width: 600px) { a { width: calc((100% - 10px) / 2); } }').hasUnbalancedClosingParen).toBe(false);
    });

    it('accepts @charset, @media, @supports selector(), @container, calc(), vendor-prefixed gradients, and common transform/animation CSS', async () => {
      const style = `
        @charset "UTF-8";
        @media (min-width: 600px) { .a { color: red; } }
        @supports (display: grid) { .b { display: grid; } }
        @supports selector(:has(a)) { .c { color: blue; } }
        @container (min-width: 20rem) { .d { color: green; } }
        .e { width: calc((100% - 10px) / 2); }
        .f { background: -webkit-linear-gradient(red, blue); }
        .g { background: -webkit-gradient(linear, 0 0, 0 100%); }
        .h { transform: rotate(30deg) scale(1.2); animation: spin 1s linear infinite; grid-template-columns: 1fr 1fr; }
      `;
      const result = await ingestValid({ style });
      expectAccepted(result);
    });

    it('rejects a disallowed at-rule and a disallowed function', async () => {
      const atRule = await ingestValid({ style: '@unknown-at-rule { a { color: red; } }' });
      expectRejected(atRule, 'AI-R16', 'CSS_AT_RULE_FORBIDDEN');

      const fn = await ingestValid({ style: 'a { color: not-a-real-function(red); }' });
      expectRejected(fn, 'AI-R17', 'CSS_FUNCTION_FORBIDDEN');
    });

    it('rejects a pseudo-class function used as an ordinary rule selector, outside @supports selector()', async () => {
      // `a:has(b)` parses (once the leading `:` is stripped off as a `div`)
      // as an ordinary value-parser `function` node named `has`, so it is
      // judged by the same closed function-name allowlist as a CSS value —
      // `@supports selector(:has(a))`'s exemption applies only inside
      // `selector()`, per AC-AI-7.
      const result = await ingestValid({ style: 'a:has(b) { color: red; }' });
      expectRejected(result, 'AI-R17', 'CSS_FUNCTION_FORBIDDEN');
    });

    it('rejects selector() used outside @supports as an ordinary property value — the pseudo-class inside it is judged normally', async () => {
      const result = await ingestValid({ style: 'a { color: selector(:has(b)); }' });
      expectRejected(result, 'AI-R17', 'CSS_FUNCTION_FORBIDDEN');
    });

    it('accepts @supports selector() nested inside another at-rule (each at-rule analyzes its own params)', async () => {
      const style = '@media screen { @supports selector(:has(a)) { .c { color: blue; } } }';
      const result = await ingestValid({ style });
      expectAccepted(result);
    });

    it('rejects a non-Google-Fonts @import and accepts a Google Fonts @import when allowWebFonts (url() form)', async () => {
      // An ordinary external URL judged by AI-R19 like any other CSS `url()`
      // — @import's params get the same URL-shaped-failure propagation as
      // every other at-rule's params (§ AI-R19: "near-miss は Google Fonts
      // ではないのでここで拒否する", i.e. by AI-R19 itself, uniformly for any
      // non-exempt external target, not only ones that resemble Google Fonts).
      const badImport = await ingestValid({ style: "@import url('https://evil.example/x.css');" });
      expectRejected(badImport, 'AI-R19', 'URL_FORBIDDEN');

      const fontsImport = "@import url('https://fonts.googleapis.com/css?family=Roboto');";
      const allowed = await ingestValid({ style: fontsImport }, { allowWebFonts: true });
      expectAccepted(allowed);
      const disallowed = await ingestValid({ style: fontsImport }, { allowWebFonts: false });
      expectRejected(disallowed, 'AI-R12', 'FONT_REFERENCE_FORBIDDEN');
    });

    it('the quoted-string @import form gets the same Google Fonts admission as the url() form', async () => {
      const badImport = await ingestValid({ style: '@import "https://evil.example/x.css";' });
      expectRejected(badImport, 'AI-R19', 'URL_FORBIDDEN');

      const fontsImport = '@import "https://fonts.googleapis.com/css?family=Roboto";';
      const allowed = await ingestValid({ style: fontsImport }, { allowWebFonts: true });
      expectAccepted(allowed);
      const disallowed = await ingestValid({ style: fontsImport }, { allowWebFonts: false });
      expectRejected(disallowed, 'AI-R12', 'FONT_REFERENCE_FORBIDDEN');
    });

    it('rejects a vendor-prefixed at-rule other than keyframes — the prefix-stripping concession is keyframes-only', async () => {
      const prefixedMedia = await ingestValid({ style: '@-webkit-media (min-width:600px) { a { color: red; } }' });
      expectRejected(prefixedMedia, 'AI-R16', 'CSS_AT_RULE_FORBIDDEN');

      const prefixedFontFace = await ingestValid({ style: "@-moz-font-face { font-family: 'X'; src: url(data:font/woff2;base64,AAAA); }" });
      expectRejected(prefixedFontFace, 'AI-R16', 'CSS_AT_RULE_FORBIDDEN');
    });

    it('accepts a vendor-prefixed @keyframes (the one at-rule the prefix-stripping concession covers)', async () => {
      const result = await ingestValid({ style: '@-webkit-keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }' });
      expectAccepted(result);
    });

    it('accepts CSS url(#fragment) for paint-server references and rejects background/text-html/query-fragment data urls', async () => {
      const ok = await ingestValid({ style: 'rect { fill: url(#g); clip-path: url(#c); } .m { filter: url(#f); mask: url(#m); }' });
      expectAccepted(ok);

      const fontAsBackground = await ingestValid({ style: 'a { background: url(data:font/woff2;base64,AAAA); }' });
      expectRejected(fontAsBackground, 'AI-R19', 'URL_FORBIDDEN');

      const textHtml = await ingestValid({ style: 'a { background: url(data:text/html,hi); }' });
      expectRejected(textHtml, 'AI-R19', 'URL_FORBIDDEN');

      const queryFragment = await ingestValid({ style: 'a { background: url(#frag?x); }' });
      expectRejected(queryFragment, 'AI-R19', 'URL_FORBIDDEN');
    });

    it('accepts a data:image url anywhere and a data:font url inside @font-face src', async () => {
      const image = await ingestValid({ style: 'a { background: url(data:image/png;base64,AAAA); }' });
      expectAccepted(image);
      const font = await ingestValid({ style: "@font-face { font-family: 'X'; src: url(data:font/woff2;base64,AAAA) format('woff2'); }" });
      expectAccepted(font);
      const quotedGoogleFont = await ingestValid(
        { style: "@font-face { font-family: 'X'; src: url('https://fonts.gstatic.com/s/x.woff2') format('woff2'); }" },
        { allowWebFonts: true },
      );
      expectAccepted(quotedGoogleFont);
    });

    it("the @font-face `src` exemption does not extend to an ordinary rule's own `src` declaration", async () => {
      // `src` is not an @font-face-exclusive property name (SVG `<image>`
      // reuses it as a plain attribute, and nothing stops an author writing
      // `.x { src: ... }`), so the exemption must key off the declaration's
      // *parent at-rule*, not its property name alone.
      const result = await ingestValid({ style: 'a { src: url(data:font/woff2;base64,AAAA); }' });
      expectRejected(result, 'AI-R19', 'URL_FORBIDDEN');
    });

    it('quoted url() argument is not treated as a CSS_STRING_ARGUMENT_FORBIDDEN violation', async () => {
      const result = await ingestValid({ style: 'a { background: url("data:image/png;base64,AAAA"); }' });
      expectAccepted(result);
    });

    it('rejects a disallowed string argument context and enforces length caps on allowed ones', async () => {
      const badContext = await ingestValid({ style: 'a { color: notallowed("red"); }' });
      expectRejected(badContext, 'AI-R17', 'CSS_FUNCTION_FORBIDDEN');

      const longFormat = `format('${'a'.repeat(33)}')`;
      const bad = await ingestValid({ style: `@font-face { font-family: 'X'; src: url(data:font/woff2;base64,AAAA) ${longFormat}; }` });
      expectRejected(bad, 'AI-R18', 'CSS_STRING_ARGUMENT_FORBIDDEN');

      const ok = await ingestValid({ style: "@font-face { font-family: 'X'; src: url(data:font/woff2;base64,AAAA) format('woff2'); }" });
      expectAccepted(ok);
    });
  });

  describe('AC-AI-8: resource limits (bytes, DOM, CSS)', () => {
    it('AI-R01: accepts normalized bytes exactly at maxBytes, rejects one byte over', async () => {
      // maxBytes itself has a floor (ARTIFACT_MIN_MAX_BYTES) below which it's
      // a programmer/configuration error, not an author-input rejection —
      // so the fixture must be padded up to that floor rather than shrunk
      // down to the tiny default fixture's natural size.
      const padded = validArtifactHtml({ body: `<p>${'x'.repeat(ARTIFACT_MIN_MAX_BYTES)}</p>` });
      const probe = await ingestHtmlArtifact(padded, authorOptions({ maxBytes: ARTIFACT_HARD_MAX_BYTES }));
      expectAccepted(probe);
      const exactBytes = probe.bytes.length;

      const atLimit = await ingestHtmlArtifact(padded, authorOptions({ maxBytes: exactBytes }));
      expectAccepted(atLimit);
      const overLimit = await ingestHtmlArtifact(padded, authorOptions({ maxBytes: exactBytes - 1 }));
      expectRejected(overLimit, 'AI-R01', 'BODY_TOO_LARGE');
    });

    it('AI-R01: a CRLF-heavy document can exceed maxBytes pre-normalization but fit after CRLF->LF shrinks it', async () => {
      // Enough literal newlines that CRLF inflation (+1 byte/newline)
      // outweighs the ~180-byte digest-marker overhead normalization adds,
      // so the CRLF form is strictly bigger than its own normalized output.
      const body = '<p>line</p>\n'.repeat(500);
      const lfHtml = validArtifactHtml({ body });
      const crlfHtml = lfHtml.replace(/\n/g, '\r\n');

      const lfResult = await ingestHtmlArtifact(lfHtml, authorOptions());
      expectAccepted(lfResult);
      const inputBytes = Buffer.byteLength(crlfHtml, 'utf8');
      expect(inputBytes).toBeGreaterThan(lfResult.bytes.length);

      const result = await ingestHtmlArtifact(crlfHtml, authorOptions({ maxBytes: Math.max(ARTIFACT_MIN_MAX_BYTES, lfResult.bytes.length) }));
      expectAccepted(result);
      expect(Buffer.from(result.bytes)).toEqual(Buffer.from(lfResult.bytes));
    });

    it('AI-R01a: rejects input over the 10 MiB hard cap before any parsing/normalization work', async () => {
      const encodeSpy = jest.spyOn(artifactParserSeam, 'encodeArtifactBytes');
      const normalizeSpy = jest.spyOn(artifactParserSeam, 'normalizeNewlines');
      try {
        const oversizedLf = `${'a'.repeat(ARTIFACT_HARD_MAX_BYTES + 1)}`;
        const resultLf = await ingestHtmlArtifact(oversizedLf, authorOptions());
        expectRejected(resultLf, 'AI-R01a', 'BODY_TOO_LARGE');

        const oversizedCrlf = `${'a\r\n'.repeat(Math.ceil((ARTIFACT_HARD_MAX_BYTES + 1) / 3))}`;
        const resultCrlf = await ingestHtmlArtifact(oversizedCrlf, authorOptions());
        expectRejected(resultCrlf, 'AI-R01a', 'BODY_TOO_LARGE');

        expect(encodeSpy).not.toHaveBeenCalled();
        expect(normalizeSpy).not.toHaveBeenCalled();
      } finally {
        encodeSpy.mockRestore();
        normalizeSpy.mockRestore();
      }
    });

    it('AI-R01a: input at exactly the 10 MiB hard cap proceeds past the pre-parse guard', async () => {
      // A single text-node body pads the document to the *exact* byte
      // target (measured inline below) — repeated tags would leave a
      // remainder from floor division and from the fixture's own non-empty
      // default body, understating the cap by tens of bytes.
      const base = validArtifactHtml({ body: '' });
      const padLength = ARTIFACT_HARD_MAX_BYTES - Buffer.byteLength(base, 'utf8');
      const html = validArtifactHtml({ body: 'x'.repeat(padLength) });
      expect(Buffer.byteLength(html, 'utf8')).toBe(ARTIFACT_HARD_MAX_BYTES);

      const normalizeSpy = jest.spyOn(artifactParserSeam, 'normalizeNewlines');
      try {
        const result = await ingestHtmlArtifact(html, authorOptions());
        // Normalization's digest-marker overhead pushes the normalized byte
        // count past `maxBytes`, so the discriminating fact that AI-R01a's
        // pre-parse guard let this exactly-at-cap input through to
        // parsing/normalization is that the actual rejection is AI-R01 (a
        // normalized-bytes check reachable only after normalizing), not
        // AI-R01a (which never runs `normalizeNewlines`).
        expectRejected(result, 'AI-R01', 'BODY_TOO_LARGE');
        expect(normalizeSpy).toHaveBeenCalled();
      } finally {
        normalizeSpy.mockRestore();
      }
    });

    it('AI-R02: 49,994 empty <p> (50,000 normalized nodes) is accepted, 49,995 (50,001) is rejected', async () => {
      const atLimitHtml = skeletonHtml('<p></p>'.repeat(49_994));
      const atLimit = await ingestHtmlArtifact(atLimitHtml, authorOptions());
      expectAccepted(atLimit);
      const parsedAtLimit = parseArtifactDocument(Buffer.from(atLimit.bytes).toString('utf8'), 'normalized');
      if (!('document' in parsedAtLimit)) throw new Error('expected a parsed document');
      expect(countTreeBudget(parsedAtLimit.document).nodes).toBe(ARTIFACT_NODE_BUDGET);

      const overHtml = skeletonHtml('<p></p>'.repeat(49_995));
      const over = await ingestHtmlArtifact(overHtml, authorOptions());
      expectRejected(over, 'AI-R02', 'DOM_LIMIT_EXCEEDED');
    });

    it('AI-R02: a stored round trip at the exact node-budget boundary (50,000 nodes) is accepted', async () => {
      const first = await ingestHtmlArtifact(skeletonHtml('<p></p>'.repeat(49_994)), authorOptions());
      expectAccepted(first);
      const second = await ingestHtmlArtifact(Buffer.from(first.bytes).toString('utf8'), storedOptions());
      expectAccepted(second);
    });

    it('AI-R02: 24,997 empty <template> (2 nodes each, 50,000 normalized nodes) is accepted, 24,998 (50,002) is rejected', async () => {
      const atLimit = await ingestHtmlArtifact(skeletonHtml('<template></template>'.repeat(24_997)), authorOptions());
      expectAccepted(atLimit);
      const over = await ingestHtmlArtifact(skeletonHtml('<template></template>'.repeat(24_998)), authorOptions());
      expectRejected(over, 'AI-R02', 'DOM_LIMIT_EXCEEDED');
    });

    it('AI-R02: a large flat run of small elements is cut off by the counting adapter before the tree completes', async () => {
      // "<p>x" repeated (each repetition auto-closes the previous <p>, per
      // HTML5's "has an element in button scope" rule) produces roughly 2
      // nodes per 4 bytes — well over the 50,000 node budget while using
      // only a small fraction of the 10 MiB byte cap.
      const html = skeletonHtml('<p>x'.repeat(200_000));
      expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(9.5 * 1024 * 1024);
      const result = await ingestHtmlArtifact(html, authorOptions());
      expectRejected(result, 'AI-R02', 'DOM_LIMIT_EXCEEDED');
    });

    it('AI-R02: deep <div> nesting is cut off by the parse-time depth guard well under the node budget', async () => {
      const nested = '<div>'.repeat(40_000) + '</div>'.repeat(40_000);
      const html = skeletonHtml(nested);
      const result = await ingestHtmlArtifact(html, authorOptions());
      expectRejected(result, 'AI-R02', 'DOM_LIMIT_EXCEEDED');
    });

    it('AI-R02: depth exactly at (127 <div>, depth 128) and one over (128 <div>, depth 129) the tree-depth limit', async () => {
      // Skeleton depths: document=-1(unrecorded), html=0, body=1, so the
      // k-th nested <div> sits at depth k+1 — depth 128 is reached at
      // <div> #127, and #128 pushes the guard to depth 129.
      const buildHtml = (n: number) => skeletonHtml('<div>'.repeat(n) + '</div>'.repeat(n));
      const atLimit = await ingestHtmlArtifact(buildHtml(ARTIFACT_MAX_TREE_DEPTH - 1), authorOptions());
      expectAccepted(atLimit);
      const over = await ingestHtmlArtifact(buildHtml(ARTIFACT_MAX_TREE_DEPTH), authorOptions());
      expectRejected(over, 'AI-R02', 'DOM_LIMIT_EXCEEDED');
    });

    it('AI-R02: <template> nested 63 levels deep (content fragment depth 127) is accepted, 64 levels (depth 129) is rejected', async () => {
      // Per spec §解析・正規化アルゴリズム step 2: template #k sits at depth
      // 2k, its content fragment at 2k+1 (body=1, template#1=2,
      // content#1=3, template#2=4, content#2=5, ...). content#64 = 129.
      const nestedTemplates = (n: number) => skeletonHtml('<template>'.repeat(n) + '</template>'.repeat(n));
      const atLimit = await ingestHtmlArtifact(nestedTemplates(63), authorOptions());
      expectAccepted(atLimit);
      const over = await ingestHtmlArtifact(nestedTemplates(64), authorOptions());
      expectRejected(over, 'AI-R02', 'DOM_LIMIT_EXCEEDED');
    });

    it('AI-R02: total attribute count and per-element attribute count boundaries', async () => {
      const attrs100 = Array.from({ length: ARTIFACT_MAX_ATTRIBUTES_PER_ELEMENT }, (_, i) => `data-a${i}="1"`).join(' ');
      const attrs101 = Array.from({ length: ARTIFACT_MAX_ATTRIBUTES_PER_ELEMENT + 1 }, (_, i) => `data-a${i}="1"`).join(' ');
      const at100 = await ingestValid({ body: `<div ${attrs100}></div>` });
      expectAccepted(at100);
      const at101 = await ingestValid({ body: `<div ${attrs101}></div>` });
      expectRejected(at101, 'AI-R02', 'DOM_LIMIT_EXCEEDED');

      // Exactly 100,000 authored attributes plus the 4 the 2 reserved
      // markers always add (name+content each) lands the normalized tree
      // exactly at ARTIFACT_MAX_TOTAL_ATTRIBUTES; skeletonHtml's empty
      // <head> means these are the only attributes in the document.
      const authoredAtLimit = ARTIFACT_MAX_TOTAL_ATTRIBUTES - MARKER_ATTRIBUTE_COUNT;
      const fullElements = Math.floor(authoredAtLimit / ARTIFACT_MAX_ATTRIBUTES_PER_ELEMENT);
      const remainder = authoredAtLimit % ARTIFACT_MAX_ATTRIBUTES_PER_ELEMENT;
      const attrsRemainder = Array.from({ length: remainder }, (_, i) => `data-r${i}="1"`).join(' ');
      const bodyAtLimit = `<div ${attrs100}></div>`.repeat(fullElements) + (remainder > 0 ? `<div ${attrsRemainder}></div>` : '');

      const atTotal = await ingestHtmlArtifact(skeletonHtml(bodyAtLimit), authorOptions());
      expectAccepted(atTotal);
      const overTotal = await ingestHtmlArtifact(skeletonHtml(`${bodyAtLimit}<div data-extra="1"></div>`), authorOptions());
      expectRejected(overTotal, 'AI-R02', 'DOM_LIMIT_EXCEEDED');
    }, 30_000);

    it('AI-R02: 1,001 elements of exactly 100 attributes each (cumulative 100,100) is rejected by the during-parse cumulative-attribute guard, which aborts mid-parse rather than after building the whole tree', async () => {
      const element = `<div ${Array.from({ length: ARTIFACT_MAX_ATTRIBUTES_PER_ELEMENT }, (_, i) => `data-a${i}="1"`).join(' ')}></div>`;

      const runtime = loadParse5Runtime();
      let generated = 0;
      const countingAdapter = createCountingTreeAdapter(runtime, {
        nodeBudget: 1_000_000,
        maxDepth: 1_000_000,
        maxTotalAttributes: ARTIFACT_MAX_TOTAL_ATTRIBUTES,
      });
      const spyAdapter: typeof countingAdapter = {
        ...countingAdapter,
        createElement: (...args) => {
          generated += 1;
          return countingAdapter.createElement(...args);
        },
      };
      // `skeletonHtml` itself contributes 3 elements (html/head/body);
      // measure that overhead rather than hardcoding it.
      runtime.Parser.parse(skeletonHtml(''), { treeAdapter: spyAdapter as never });
      const skeletonElementCount = generated;

      // 2,000 elements are supplied, but the cumulative guard (100 * 1,001 =
      // 100,100 > ARTIFACT_MAX_TOTAL_ATTRIBUTES) must fire on the 1,001st —
      // well before the parser would reach the remaining 999.
      generated = 0;
      const oversupplied = skeletonHtml(element.repeat(2_000));
      expect(() => runtime.Parser.parse(oversupplied, { treeAdapter: spyAdapter as never })).toThrow(ArtifactNodeBudgetExceeded);
      expect(generated).toBe(skeletonElementCount + 1_001);

      const html = skeletonHtml(element.repeat(1_001));
      const result = await ingestHtmlArtifact(html, authorOptions());
      expectRejected(result, 'AI-R02', 'DOM_LIMIT_EXCEEDED');
    }, 30_000);

    it('CSS: value node total and paren depth boundaries reject before PostCSS/value-parser run', async () => {
      const parseStylesheetSpy = jest.spyOn(artifactParserSeam, 'parseStylesheet');
      const parseValueSpy = jest.spyOn(artifactParserSeam, 'parseValue');
      try {
        const manyTokens = `a{p: ${Array.from({ length: 300_001 }, () => 'a').join(' ')}}`;
        parseStylesheetSpy.mockClear();
        const tokenResult = await ingestValid({ style: manyTokens });
        expectRejected(tokenResult, 'AI-R20a', 'CSS_VALUE_NODE_LIMIT_EXCEEDED');
        expect(parseStylesheetSpy).not.toHaveBeenCalled();

        const deepCalc = `a{width:${'calc('.repeat(65)}1px${')'.repeat(65)}}`;
        parseValueSpy.mockClear();
        const depthResult = await ingestValid({ style: deepCalc });
        expectRejected(depthResult, 'AI-R20b', 'CSS_VALUE_DEPTH_EXCEEDED');
        expect(parseValueSpy).not.toHaveBeenCalled();

        const okCalc = `a{width:${'calc('.repeat(64)}1px${')'.repeat(64)}}`;
        // 64 opening parens nested is allowed (depth ceiling is inclusive);
        // this also exercises the "deep calc never reaches value-parser
        // recursion" boundary without stack-overflowing.
        const okResult = await ingestValid({ style: okCalc });
        expect(okResult.ok || okResult.rejection.ruleId !== 'AI-R20b').toBe(true);
      } finally {
        parseStylesheetSpy.mockRestore();
        parseValueSpy.mockRestore();
      }
    }, 30_000);

    it('CSS: exactly 300,000 word tokens passes the S2 pre-scan (PostCSS runs) before the later value-node budget rejects it', async () => {
      const parseStylesheetSpy = jest.spyOn(artifactParserSeam, 'parseStylesheet');
      try {
        // `a{p: <N words>}` contributes the selector `a` and the property
        // `p` as 2 extra word tokens on top of the N space-separated value
        // words — measured inline rather than assumed, per scanCssText's
        // own definition of a word token.
        const cssText = `a{p: ${words(ARTIFACT_CSS_MAX_TOKENS - 2)}}`;
        expect(scanCssText(cssText).wordTokens).toBe(ARTIFACT_CSS_MAX_TOKENS);
        parseStylesheetSpy.mockClear();
        const result = await ingestValid({ style: cssText });
        expectRejected(result, 'AI-R20a', 'CSS_VALUE_NODE_LIMIT_EXCEEDED');
        expect(parseStylesheetSpy).toHaveBeenCalled();
      } finally {
        parseStylesheetSpy.mockRestore();
      }
    }, 30_000);

    it('CSS: 100,000-deep calc() nesting is rejected by the S2 paren-depth pre-scan without invoking PostCSS/value-parser or overflowing the stack', async () => {
      const parseStylesheetSpy = jest.spyOn(artifactParserSeam, 'parseStylesheet');
      const parseValueSpy = jest.spyOn(artifactParserSeam, 'parseValue');
      try {
        const deepCalc = `a{width:${'calc('.repeat(100_000)}1px${')'.repeat(100_000)}}`;
        const result = await ingestValid({ style: deepCalc });
        expectRejected(result, 'AI-R20b', 'CSS_VALUE_DEPTH_EXCEEDED');
        expect(parseStylesheetSpy).not.toHaveBeenCalled();
        expect(parseValueSpy).not.toHaveBeenCalled();
      } finally {
        parseStylesheetSpy.mockRestore();
        parseValueSpy.mockRestore();
      }
    }, 30_000);

    it('AI-R20a (S4, document-wide): the value-node total is summed across every <style> block, not reset per block', async () => {
      // `a{p:<25000 words>}` contributes exactly 50,000 value nodes: 1 for
      // its own selector (a bare word) + 49,999 for the space-separated
      // word list (N words -> 2N-1 nodes). Two such blocks sum to exactly
      // the 100,000-node limit; `@charset "UTF-8";` contributes exactly 1
      // more (a single bare string, no paired selector), tipping the same
      // two-block total one node over.
      const styleA = `a{p:${words(25_000)}}`;
      const styleB = `a{p:${words(25_000)}}`;
      const atLimit = await ingestValid({ style: styleA, body: `<style>${styleB}</style>` });
      expectAccepted(atLimit);

      const styleBPlusOne = `@charset "UTF-8";a{p:${words(25_000)}}`;
      const overLimit = await ingestValid({ style: styleA, body: `<style>${styleBPlusOne}</style>` });
      expectRejected(overLimit, 'AI-R20a', 'CSS_VALUE_NODE_LIMIT_EXCEEDED');
    }, 30_000);

    it('CSS: source size boundary — exactly 1 MiB is accepted, 1 byte over rejects before PostCSS runs', async () => {
      const parseStylesheetSpy = jest.spyOn(artifactParserSeam, 'parseStylesheet');
      try {
        // A `/* ... */` comment contributes 0 word tokens and 0 paren depth
        // (scanCssText skips comment bodies), so it isolates S1 (byte size)
        // from S2's other checks. Overhead is the 3-byte `/* ` prefix + the
        // 3-byte ` */` suffix.
        const commentOverhead = 6;
        const atLimit = `/* ${'a'.repeat(ARTIFACT_CSS_MAX_BYTES - commentOverhead)} */`;
        expect(Buffer.byteLength(atLimit, 'utf8')).toBe(ARTIFACT_CSS_MAX_BYTES);
        const atLimitResult = await ingestValid({ style: atLimit });
        expectAccepted(atLimitResult);

        const oversized = `/* ${'a'.repeat(ARTIFACT_CSS_MAX_BYTES - commentOverhead + 1)} */`;
        expect(Buffer.byteLength(oversized, 'utf8')).toBe(ARTIFACT_CSS_MAX_BYTES + 1);
        parseStylesheetSpy.mockClear();
        const result = await ingestValid({ style: oversized });
        expectRejected(result, 'AI-R20c', 'CSS_SOURCE_TOO_LARGE');
        expect(parseStylesheetSpy).not.toHaveBeenCalled();
      } finally {
        parseStylesheetSpy.mockRestore();
      }
    });

    it('normalized-output-only limit overflow is rejected even when the source pass was fine', async () => {
      const overHtml = skeletonHtml('<p></p>'.repeat(49_995));

      // Confirm the SOURCE pass alone (before the 2 digest markers are
      // added) is still within budget — the rejection below is specifically
      // a normalized-pass-only overflow, not a source-pass one.
      const sourceParsed = parseArtifactDocument(overHtml, 'source');
      if (!('document' in sourceParsed)) throw new Error('expected the source pass to parse successfully');
      expect(countTreeBudget(sourceParsed.document).nodes).toBeLessThanOrEqual(ARTIFACT_NODE_BUDGET);

      const result = await ingestHtmlArtifact(overHtml, authorOptions());
      expectRejected(result, 'AI-R02', 'DOM_LIMIT_EXCEEDED');
    });
  });

  describe('createCountingTreeAdapter (standalone AC-AI-8 invariant tests)', () => {
    it('throws once the node budget is exceeded and matches countTreeBudget on accepted trees', () => {
      const runtime = loadParse5Runtime();
      const adapter = createCountingTreeAdapter(runtime, { nodeBudget: 5, maxDepth: 128, maxTotalAttributes: 1000 });
      expect(() => runtime.Parser.parse('<p></p><p></p><p></p><p></p><p></p>', { treeAdapter: adapter as never })).toThrow();
    });

    it('generation count equals the post-parse held count for misnested/foster-parented/template fixtures', () => {
      const fixtures = [
        '<!doctype html><html><head></head><body>' + '<b><i><u>x<p>y</b>z</i>w</u>v'.repeat(50) + '</body></html>',
        '<!doctype html><html><head></head><body><table><tr><td>cell</td></tr>stray-text</table></body></html>',
        '<!doctype html><html><head></head><body><a href="#a"><a href="#b">nested-a</a></a></body></html>',
        '<!doctype html><html><head></head><body><template><p>x</p></template></body></html>',
        '<!doctype html><html><head></head><body>x<!doctype html>y</body></html>',
      ];
      for (const fixture of fixtures) {
        let generated = 0;
        const runtime = loadParse5Runtime();
        const base = runtime.defaultTreeAdapter;
        const countingAdapter = createCountingTreeAdapter(runtime, { nodeBudget: 1_000_000, maxDepth: 1_000_000, maxTotalAttributes: 1_000_000 });
        const spyAdapter: typeof countingAdapter = {
          ...countingAdapter,
          createElement: (...args) => {
            generated += 1;
            return countingAdapter.createElement(...args);
          },
          createCommentNode: (...args) => {
            generated += 1;
            return countingAdapter.createCommentNode(...args);
          },
          createDocumentFragment: (...args) => {
            generated += 1;
            return countingAdapter.createDocumentFragment(...args);
          },
          setDocumentType: (document, name, publicId, systemId) => {
            const hasExisting = base.getChildNodes(document).some((n) => base.isDocumentTypeNode(n));
            if (!hasExisting) generated += 1;
            countingAdapter.setDocumentType(document, name, publicId, systemId);
          },
          insertText: (parentNode, text) => {
            const children = base.getChildNodes(parentNode);
            const last = children[children.length - 1];
            if (!(last && base.isTextNode(last))) generated += 1;
            countingAdapter.insertText(parentNode, text);
          },
          insertTextBefore: (parentNode, text, referenceNode) => {
            const children = base.getChildNodes(parentNode);
            const idx = children.indexOf(referenceNode);
            const prev = idx > 0 ? children[idx - 1] : undefined;
            if (!(prev && base.isTextNode(prev))) generated += 1;
            countingAdapter.insertTextBefore(parentNode, text, referenceNode);
          },
        };
        const document = runtime.Parser.parse(fixture, { treeAdapter: spyAdapter as never, onParseError: () => {} }) as never;
        const budget = countTreeBudget(document);
        expect(generated).toBe(budget.nodes);
      }
    });

    it('tokenizer guard rejects 1000 distinct attributes and 99+repeated-duplicate attributes with zero generated nodes', () => {
      const runtime = loadParse5Runtime();
      const { Parser } = getArtifactBudgetClasses(runtime);
      let generated = 0;
      const countingAdapter = createCountingTreeAdapter(runtime, { nodeBudget: 1_000_000, maxDepth: 1_000_000, maxTotalAttributes: 1_000_000 });
      const spyAdapter: typeof countingAdapter = {
        ...countingAdapter,
        createElement: (...args) => {
          generated += 1;
          return countingAdapter.createElement(...args);
        },
      };
      const manyDistinct = `<div ${Array.from({ length: 1000 }, (_, i) => `a${i}="1"`).join(' ')}></div>`;
      expect(() => Parser.parse(manyDistinct, { treeAdapter: spyAdapter as never })).toThrow();
      expect(generated).toBe(0);

      generated = 0;
      const dup = `<div ${Array.from({ length: 99 }, (_, i) => `a${i}="1"`).join(' ')} ${'dup="1" '.repeat(100_000)}></div>`;
      expect(() => Parser.parse(dup, { treeAdapter: spyAdapter as never })).toThrow();
      expect(generated).toBe(0);

      // 100 attributes on one element is accepted; 101 is not (tokenizer
      // guard, boundary exactly at ARTIFACT_MAX_ATTRIBUTES_PER_ELEMENT).
      const exactly100 = `<div ${Array.from({ length: 100 }, (_, i) => `a${i}="1"`).join(' ')}></div>`;
      expect(() => Parser.parse(exactly100, { treeAdapter: runtime.defaultTreeAdapter as never })).not.toThrow();
      const exactly101 = `<div ${Array.from({ length: 101 }, (_, i) => `a${i}="1"`).join(' ')}></div>`;
      expect(() => Parser.parse(exactly101, { treeAdapter: runtime.defaultTreeAdapter as never })).toThrow();

      // The guarded parser produces the same tree as the plain parser for an
      // ordinary document (the tokenizer override is purely additive).
      const ordinary = validArtifactHtml();
      const plainDoc = runtime.Parser.parse(ordinary, {}) as never;
      const guardedDoc = Parser.parse(ordinary, {}) as never;
      expect(countTreeBudget(guardedDoc).nodes).toBe(countTreeBudget(plainDoc).nodes);
    }, 30_000);
  });
});
