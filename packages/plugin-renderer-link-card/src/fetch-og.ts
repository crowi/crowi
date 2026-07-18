import { checkHostnameSsrf, type DnsLookupFn, type SsrfCheckResult } from './ssrf-guard';

/**
 * SSRF-guarded OGP fetch. GET-only (HEAD can't be relied on to return
 * OGP tags), no credentials/cookies/Authorization ever sent, manual
 * redirect handling (each hop re-validated by `checkHostnameSsrf`),
 * 5s timeout spanning the whole hop chain, and a hard 512KB response
 * cap. See spec §"OGP 取得" / §"SSRF ガード".
 */

/** Extracted OGP (+ `<title>` fallback) fields. All optional — a page may have none of them. */
export interface OgMeta {
  title?: string;
  description?: string;
  /** Always an absolute http(s) URL when present — other schemes are dropped at extraction time. */
  image?: string;
  siteName?: string;
}

export type FetchOgErrorCode = 'blocked' | 'bad-scheme' | 'timeout' | 'too-large' | 'http-error' | 'unsupported-content-type' | 'network' | 'unknown';

export type FetchOgResult =
  | { kind: 'ok'; meta: OgMeta }
  | {
      kind: 'error';
      code: FetchOgErrorCode;
      httpStatus?: number;
      /** Parsed `Retry-After` response header (seconds), only ever populated for a 429 `http-error`. See `parseRetryAfterSeconds`. */
      retryAfterSec?: number;
    };

/** Plugin-internal concurrency cap — "同時5fetch" (spec §"SSRF ガード"). */
export const FETCH_CONCURRENCY_LIMIT = 5;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
/**
 * Upper bound for a parsed `Retry-After` (seconds). `retryAfterSec`
 * flows straight into `cache/index.ts:pickTtl` → `expiresAt = new
 * Date(now.getTime() + ttlSec * 1000)` with no clamp on that end — an
 * attacker- or misconfigured-upstream-controlled header (a huge
 * `delta-seconds` digit string, or a date far in the future) could
 * otherwise overflow into an `Invalid Date` and make the cache write
 * fail, losing the fallback card entirely. 24h keeps the same order of
 * magnitude as `STALE_IF_ERROR_MAX_AGE_SEC` while comfortably covering
 * any legitimate rate-limit cadence.
 */
const MAX_RETRY_AFTER_SEC = 24 * 60 * 60;
const USER_AGENT = 'Crowi-LinkCard/1.0';
const HTML_CONTENT_TYPE_RE = /^(text\/html|application\/xhtml\+xml)\b/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Minimal async semaphore — no `p-limit`-style shared util exists in
 * this repo (spec §"newDeps"), and the cap is small/internal enough
 * that a hand-rolled queue is simpler than adding a dependency.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

const sharedSemaphore = new Semaphore(FETCH_CONCURRENCY_LIMIT);

export interface FetchOgDeps {
  /** Test seam — defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam — threaded through to `checkHostnameSsrf` for both the initial URL and every redirect hop. */
  dnsLookup?: DnsLookupFn;
  /** Test seam — defaults to the module-level shared semaphore (production concurrency cap). */
  semaphore?: Semaphore;
}

export async function fetchOg(inputUrl: string, deps: FetchOgDeps = {}): Promise<FetchOgResult> {
  const semaphore = deps.semaphore ?? sharedSemaphore;
  const release = await semaphore.acquire();
  try {
    return await fetchOgLocked(inputUrl, deps);
  } finally {
    release();
  }
}

async function fetchOgLocked(inputUrl: string, deps: FetchOgDeps): Promise<FetchOgResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  let current: URL;
  try {
    current = new URL(inputUrl);
  } catch {
    return { kind: 'error', code: 'bad-scheme' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        return { kind: 'error', code: 'bad-scheme' };
      }

      // `checkHostnameSsrf`'s DNS lookup does not accept (and does not
      // itself observe) an `AbortSignal` — without racing it against
      // the same deadline as the fetch below, a slow/hanging DNS
      // resolution could hold this hop (and its concurrency-semaphore
      // slot) open well past `FETCH_TIMEOUT_MS`. `raceAbort` makes the
      // single overall deadline cover every hop's DNS lookup too, not
      // just its `fetch()` call.
      let guard: SsrfCheckResult;
      try {
        guard = await raceAbort(checkHostnameSsrf(current.hostname, deps.dnsLookup), controller.signal);
      } catch {
        return { kind: 'error', code: 'timeout' };
      }
      if (!guard.allowed) {
        return { kind: 'error', code: 'blocked' };
      }

      let response: Response;
      try {
        response = await fetchImpl(current.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
        });
      } catch (err) {
        const aborted = controller.signal.aborted || (err instanceof Error && err.name === 'AbortError');
        return { kind: 'error', code: aborted ? 'timeout' : 'network' };
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        if (!location || hop === MAX_REDIRECTS) {
          return { kind: 'error', code: 'http-error', httpStatus: response.status };
        }
        // Cancel (never drain) the redirect body before following the next
        // hop: draining would buffer however many bytes the server chooses
        // to attach to a 3xx — an attacker-controlled redirect chain could
        // use that as an amplification vector inside our own 5s window.
        // The cost is that an aborted body may prevent this connection's
        // keep-alive reuse for a same-origin next hop — accepted; most
        // hops change origin anyway (http→https), where no reuse exists.
        await response.body?.cancel().catch(() => undefined);
        try {
          current = new URL(location, current);
        } catch {
          return { kind: 'error', code: 'http-error', httpStatus: response.status };
        }
        continue; // next iteration re-validates scheme + SSRF for the new hop
      }

      if (!response.ok) {
        // `retryAfterSec` only matters for 429 (`toRenderError` in
        // `index.ts` is the sole consumer) — parsing it for every other
        // status would be dead work.
        const retryAfterSec = response.status === 429 ? parseRetryAfterSeconds(response.headers.get('retry-after')) : undefined;
        return { kind: 'error', code: 'http-error', httpStatus: response.status, retryAfterSec };
      }

      // Spec/AC-3: a non-HTML response is a safe-failure case (like SSRF/
      // timeout/oversized-body/bad-scheme), NOT a successful degrade — it
      // falls into the same working-link error card as every other guard.
      const contentType = response.headers.get('content-type') ?? '';
      if (!HTML_CONTENT_TYPE_RE.test(contentType)) {
        return { kind: 'error', code: 'unsupported-content-type' };
      }

      const body = await readBodyCapped(response, MAX_BODY_BYTES);
      if (!body.ok) {
        return { kind: 'error', code: 'too-large' };
      }

      const charset = detectCharset(contentType, body.buffer);
      const html = decodeHtml(body.buffer, charset);
      return { kind: 'ok', meta: extractOgMeta(html) };
    }
    // Unreachable in practice — the loop's own redirect-count check
    // above always returns before falling off the end, but TypeScript
    // wants an exhaustive return.
    return { kind: 'error', code: 'http-error' };
  } catch {
    return { kind: 'error', code: 'unknown' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Race `promise` against `signal`'s `abort` event. Some awaited
 * operations in this module (`checkHostnameSsrf`'s `dns.lookup`, which
 * has no `AbortSignal` parameter) can't be cancelled directly, but they
 * still must not be allowed to hold the fetch's overall deadline open
 * indefinitely — wrapping the await in `raceAbort` makes the promise
 * this function returns settle (reject) the moment `signal` aborts,
 * regardless of whether the wrapped promise itself ever does.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Read `response.body` up to `maxBytes`. As soon as more bytes than the
 * cap arrive, the stream is cancelled and this reports `ok: false` —
 * spec: "応答は先頭512KBまで読んで打ち切り"; AC-3 treats an oversized
 * response as a safe-failure case, so exceeding the cap is a reject
 * rather than a silent truncate-and-parse.
 */
async function readBodyCapped(response: Response, maxBytes: number): Promise<{ ok: true; buffer: Buffer } | { ok: false }> {
  if (!response.body) {
    const buf = Buffer.from(await response.arrayBuffer());
    return buf.byteLength > maxBytes ? { ok: false } : { ok: true, buffer: buf };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false };
      }
      chunks.push(value);
    }
  }
  // `Buffer.concat` accepts `Uint8Array[]` directly — a `Buffer.from` per
  // chunk would copy every chunk twice (up to 2x the 512KB cap in memcpy).
  return { ok: true, buffer: Buffer.concat(chunks) };
}

/** Resolve the charset to decode the body with — header first, then a `<meta charset>` sniff in the first 2KB, else UTF-8. */
function detectCharset(contentTypeHeader: string, buffer: Buffer): string {
  const headerMatch = /charset=([^;]+)/i.exec(contentTypeHeader);
  if (headerMatch) return normalizeCharsetLabel(headerMatch[1]);
  const prefix = buffer.subarray(0, Math.min(buffer.length, 2048)).toString('latin1');
  const metaMatch = /<meta[^>]+charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i.exec(prefix);
  if (metaMatch) return normalizeCharsetLabel(metaMatch[1]);
  return 'utf-8';
}

function normalizeCharsetLabel(label: string): string {
  const trimmed = label.trim().replace(/["']/g, '').toLowerCase();
  return trimmed || 'utf-8';
}

/**
 * Parse a `Retry-After` header value (RFC 9110 §10.2.3) into whole
 * seconds. Accepts either form the spec allows — `delta-seconds` (a
 * non-negative integer) or an HTTP-date, converted to the delta from
 * now (clamped to 0 for a date already in the past). Returns
 * `undefined` for a missing/unparsable header rather than guessing.
 * The result is always clamped to `[0, MAX_RETRY_AFTER_SEC]` — see
 * that constant's doc comment for why an unclamped value is unsafe
 * downstream.
 */
function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds)) return undefined;
    return Math.min(seconds, MAX_RETRY_AFTER_SEC);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  const deltaSec = Math.ceil((dateMs - Date.now()) / 1000);
  return Math.min(Math.max(0, deltaSec), MAX_RETRY_AFTER_SEC);
}

function decodeHtml(buffer: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString('utf-8');
  }
}

const META_TAG_RE = /<meta\b[^>]*>/gi;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
const TITLE_TAG_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

/** Extract `og:title` / `og:description` / `og:image` / `og:site_name` (+ `<title>` fallback) from raw HTML via a lightweight regex scan (no DOM parser dependency — spec §"newDeps"). */
export function extractOgMeta(html: string): OgMeta {
  const metaMap = new Map<string, string>();
  META_TAG_RE.lastIndex = 0;
  let match = META_TAG_RE.exec(html);
  while (match) {
    const attrs = parseAttrs(match[0]);
    const key = attrs.get('property') ?? attrs.get('name');
    const content = attrs.get('content');
    if (key && content !== undefined && !metaMap.has(key)) {
      metaMap.set(key, decodeHtmlEntities(content));
    }
    match = META_TAG_RE.exec(html);
  }

  const titleFallback = TITLE_TAG_RE.exec(html);
  const title = metaMap.get('og:title') || (titleFallback ? decodeHtmlEntities(titleFallback[1]).trim() : undefined);
  const description = metaMap.get('og:description') || metaMap.get('description');
  const image = metaMap.get('og:image');
  const siteName = metaMap.get('og:site_name');

  return {
    title: title || undefined,
    description: description || undefined,
    image: isHttpUrl(image) ? image : undefined,
    siteName: siteName || undefined,
  };
}

function parseAttrs(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  ATTR_RE.lastIndex = 0;
  let match = ATTR_RE.exec(tag);
  while (match) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs.set(name, value);
    match = ATTR_RE.exec(tag);
  }
  return attrs;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** True when `value` parses as an absolute `http:`/`https:` URL. The single scheme gate for BOTH defence layers — the fetch entry (here) and the card renderer's `safeHref`/`safeImageSrc` (`render-card.ts`) import this one predicate so a future policy change cannot desynchronize them. */
export function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
