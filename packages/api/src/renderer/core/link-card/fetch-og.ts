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

export type FetchOgErrorCode = 'blocked' | 'bad-scheme' | 'timeout' | 'too-large' | 'http-error' | 'unsupported-content-type' | 'network' | 'unknown' | 'busy';

export type FetchOgResult =
  | { kind: 'ok'; meta: OgMeta }
  | {
      kind: 'error';
      code: FetchOgErrorCode;
      httpStatus?: number;
      /** Parsed `Retry-After` response header (seconds), populated for any non-ok response that sent one. Which statuses honour it is `index.ts:toRenderError`'s policy. See `parseRetryAfterSeconds`. */
      retryAfterSec?: number;
    };

/** Plugin-internal concurrency cap — "同時5fetch" (spec §"SSRF ガード"). */
export const FETCH_CONCURRENCY_LIMIT = 5;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'Crowi-LinkCard/1.0';
const HTML_CONTENT_TYPE_RE = /^(text\/html|application\/xhtml\+xml)\b/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Bounds on the shared `Semaphore`'s WAIT QUEUE — distinct from
 * `FETCH_CONCURRENCY_LIMIT` above, which caps concurrent ACTIVE fetches
 * and is unchanged. Without these, one page embedding `@[card]` links
 * to many unique, slow/unresponsive hosts dispatches its whole
 * `Promise.all` batch (`../embed-tags.ts`) straight at the shared
 * 5-slot semaphore at once — every request past the 5th sat in
 * `Semaphore`'s queue as an unresolved Promise with no cap and no
 * deadline, so both the count of outstanding Promises and the time
 * before any of them settled were unbounded (crowi-review
 * CROWI-REVIEW-002, high severity DoS).
 *
 * - `FETCH_QUEUE_LIMIT`: once `active + queued` requests already equal
 *   `FETCH_CONCURRENCY_LIMIT + FETCH_QUEUE_LIMIT`, a further `acquire()`
 *   fails immediately with `busy` — no `Promise` is ever pushed onto
 *   the queue past this point, so the total number of outstanding
 *   acquisitions is capped at a constant no matter how many callers
 *   pile on in one dispatch. A real wiki page realistically embeds at
 *   most a handful to a few dozen distinct link cards — a page that is
 *   nothing but `@[card]` embeds is already an edge case — so 50 keeps
 *   generous headroom for that while landing on the same order of
 *   magnitude as the existing per-page code-block admission-dispatch
 *   cap (`MAX_ADMISSION_DISPATCH_COUNT = 50` in
 *   `../code-block-dispatch.ts`), even though link-card has no
 *   dedicated per-page embed-count cap of its own to reconcile
 *   against.
 * - `FETCH_QUEUE_WAIT_MS`: a request that DID get a queue slot still
 *   gives up (`busy`) if it hasn't been granted an active slot within
 *   this deadline — a separate, PRE-acquisition deadline from
 *   `FETCH_TIMEOUT_MS` above (which only starts ticking once a slot is
 *   already held). An active slot is always released within
 *   `FETCH_TIMEOUT_MS` (its fetch either completes or its
 *   `AbortController` fires), so under normal load a queued waiter
 *   should reach the front within roughly one such cycle; doubling it
 *   to `2 * FETCH_TIMEOUT_MS` absorbs a second cycle's worth of jitter
 *   before concluding the queue is genuinely stuck rather than merely
 *   busy.
 */
export const FETCH_QUEUE_LIMIT = 50;
export const FETCH_QUEUE_WAIT_MS = 2 * FETCH_TIMEOUT_MS;

/** What `Semaphore.acquire()` resolves to — either a granted slot (with its release callback) or a rejection (queue-length cap hit, or the wait deadline elapsed). Callers never distinguish the two rejection causes — both map to the same `busy` outcome. */
export type SemaphoreAcquireResult = { ok: true; release: () => void } | { ok: false };

/**
 * Minimal async semaphore — no `p-limit`-style shared util exists in
 * this repo (spec §"newDeps"), and the cap is small/internal enough
 * that a hand-rolled queue is simpler than adding a dependency.
 *
 * Bounded on two axes (see `FETCH_QUEUE_LIMIT` / `FETCH_QUEUE_WAIT_MS`
 * above — this class is deliberately parameterized rather than
 * hardcoding those production constants, so tests can exercise the
 * same cap/timeout behavior at a smaller, fast scale): `queueLimit`
 * caps how many callers may ever sit in `queue` at once — beyond it,
 * `acquire()` fails synchronously with `{ ok: false }` without ever
 * constructing a `Promise` that would sit unresolved; `waitMs` caps how
 * long an accepted waiter may sit in `queue` before giving up the same
 * way.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly max: number,
    private readonly queueLimit: number = FETCH_QUEUE_LIMIT,
    private readonly waitMs: number = FETCH_QUEUE_WAIT_MS,
  ) {}

  async acquire(): Promise<SemaphoreAcquireResult> {
    if (this.active < this.max) {
      this.active++;
      return { ok: true, release: () => this.release() };
    }
    if (this.queue.length >= this.queueLimit) {
      // Queue-length cap reached — the core DoS fix. Fail synchronously
      // without ever pushing a new entry onto `queue`, so the total
      // count of outstanding acquisitions (active + queued) never
      // exceeds `max + queueLimit`, a constant, regardless of how many
      // callers pile on in one dispatch.
      return { ok: false };
    }
    return new Promise<SemaphoreAcquireResult>((resolve) => {
      let settled = false;
      const grant = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active++;
        resolve({ ok: true, release: () => this.release() });
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this.queue.indexOf(grant);
        if (idx !== -1) this.queue.splice(idx, 1);
        resolve({ ok: false });
      }, this.waitMs);
      this.queue.push(grant);
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
  const acquired = await semaphore.acquire();
  if (!acquired.ok) {
    // Queue-length cap hit, or the pre-acquisition wait deadline
    // elapsed — either way this request never reached (and never will
    // reach) the actual fetch. See `FETCH_QUEUE_LIMIT` / `FETCH_QUEUE_WAIT_MS`.
    return { kind: 'error', code: 'busy' };
  }
  try {
    return await fetchOgLocked(inputUrl, deps);
  } finally {
    acquired.release();
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
        // Pure data extraction — parsed whenever the header is present.
        // WHICH statuses honour it is policy, and that lives in one place
        // (`index.ts:toRenderError`), not split across both files.
        const retryAfterSec = parseRetryAfterSeconds(response.headers.get('retry-after'));
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
 * Upper-bounding is NOT done here — the cache core clamps every
 * plugin-supplied TTL at its own boundary (`cache/index.ts:clampTtl`,
 * `MAX_TTL_SEC`), so the invariant holds for all plugins at once. See
 * that constant's doc comment for why an unclamped value is unsafe
 * downstream.
 */
function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds)) return undefined;
    return seconds;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  const deltaSec = Math.ceil((dateMs - Date.now()) / 1000);
  return Math.max(0, deltaSec);
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
