import { Semaphore } from 'src/util/semaphore';
import { extractOgMeta, FETCH_CONCURRENCY_LIMIT, FETCH_QUEUE_LIMIT, FETCH_QUEUE_WAIT_MS, fetchOg } from './fetch-og';
import { type DnsLookupResult } from './ssrf-guard';

const PUBLIC_ADDRESS: DnsLookupResult = { address: '93.184.216.34', family: 4 };
const allowLookup = () => jest.fn().mockResolvedValue(PUBLIC_ADDRESS);
const denyLookup = () => jest.fn().mockResolvedValue({ address: '10.0.0.5', family: 4 } satisfies DnsLookupResult);

function htmlResponse(html: string, init: { status?: number; contentType?: string } = {}): Response {
  return new Response(html, {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'text/html; charset=utf-8' },
  });
}

function redirectResponse(location: string, status = 302): Response {
  return new Response('', { status, headers: { location } });
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('fetchOg — success paths', () => {
  it('extracts a full card (title/description/image/site_name) from a well-formed OGP page', async () => {
    const html = [
      '<html><head>',
      '<meta property="og:title" content="Example Title">',
      '<meta property="og:description" content="Example description text.">',
      '<meta property="og:image" content="https://example.test/og.png">',
      '<meta property="og:site_name" content="Example Site">',
      '</head><body></body></html>',
    ].join('');
    const fetchImpl = jest.fn().mockResolvedValue(htmlResponse(html));
    const result = await fetchOg('https://example.test/page', { fetchImpl, dnsLookup: allowLookup() });
    expect(result).toEqual({
      kind: 'ok',
      meta: {
        title: 'Example Title',
        description: 'Example description text.',
        image: 'https://example.test/og.png',
        siteName: 'Example Site',
      },
    });
  });

  it('falls back to <title> when og:title is absent', async () => {
    const html = '<html><head><title>Fallback Title</title></head><body></body></html>';
    const fetchImpl = jest.fn().mockResolvedValue(htmlResponse(html));
    const result = await fetchOg('https://example.test/page', { fetchImpl, dnsLookup: allowLookup() });
    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' && result.meta.title).toBe('Fallback Title');
  });

  it('omits og:image entirely when the page has none — text card, not an error', async () => {
    const html = '<html><head><meta property="og:title" content="No image here"></head></html>';
    const fetchImpl = jest.fn().mockResolvedValue(htmlResponse(html));
    const result = await fetchOg('https://example.test/page', { fetchImpl, dnsLookup: allowLookup() });
    expect(result).toEqual({ kind: 'ok', meta: { title: 'No image here', description: undefined, image: undefined, siteName: undefined } });
  });

  it('decodes a non-UTF-8 charset declared in the Content-Type header', async () => {
    // U+00E9 ('é') encoded as Latin-1 (0xE9) inside a title.
    const before = Buffer.from('<html><head><title>caf', 'latin1');
    const accented = Buffer.from([0xe9]);
    const after = Buffer.from('</title></head></html>', 'latin1');
    const buffer = Buffer.concat([before, accented, after]);
    const fetchImpl = jest.fn().mockResolvedValue(new Response(buffer, { status: 200, headers: { 'content-type': 'text/html; charset=iso-8859-1' } }));
    const result = await fetchOg('https://example.test/page', { fetchImpl, dnsLookup: allowLookup() });
    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' && result.meta.title).toBe('café');
  });
});

describe('fetchOg — SSRF (3 vectors: direct IP literal, DNS-resolved, redirect-induced)', () => {
  it('blocks a direct private-IP-literal URL without ever calling fetch', async () => {
    const fetchImpl = jest.fn();
    const result = await fetchOg('http://127.0.0.1/admin', { fetchImpl });
    expect(result).toEqual({ kind: 'error', code: 'blocked' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks a hostname that DNS-resolves to a private address without ever calling fetch', async () => {
    const fetchImpl = jest.fn();
    const result = await fetchOg('http://internal.example.test/', { fetchImpl, dnsLookup: denyLookup() });
    expect(result).toEqual({ kind: 'error', code: 'blocked' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows a bracketed public IPv6 literal URL (WHATWG `URL.hostname` keeps the `[…]` wrapper — reviewer finding)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(htmlResponse('<html><head><meta property="og:title" content="v6"></head></html>'));
    const dnsLookup = jest.fn();
    const result = await fetchOg('http://[2001:4860:4860::8888]/page', { fetchImpl, dnsLookup });
    expect(result.kind).toBe('ok');
    // Recognised as an IP literal purely syntactically — no DNS lookup.
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it('blocks a bracketed loopback IPv6 literal URL', async () => {
    const fetchImpl = jest.fn();
    const result = await fetchOg('http://[::1]/admin', { fetchImpl });
    expect(result).toEqual({ kind: 'error', code: 'blocked' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('re-validates on the redirect hop and blocks a redirect that leads to a private address', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(redirectResponse('http://internal.example.test/secret'))
      .mockResolvedValueOnce(htmlResponse('<html></html>'));
    // First hop's hostname resolves publicly; the redirect TARGET resolves privately.
    const dnsLookup = jest.fn().mockImplementation(async (hostname: string) => {
      if (hostname === 'internal.example.test') return { address: '10.0.0.9', family: 4 };
      return PUBLIC_ADDRESS;
    });
    const result = await fetchOg('https://example.test/', { fetchImpl, dnsLookup });
    expect(result).toEqual({ kind: 'error', code: 'blocked' });
    // The guard rejected before the 2nd GET was ever attempted.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('fetchOg — redirects', () => {
  it('follows up to 3 redirects and renders the final page', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(redirectResponse('https://example.test/hop1'))
      .mockResolvedValueOnce(redirectResponse('https://example.test/hop2'))
      .mockResolvedValueOnce(redirectResponse('https://example.test/hop3'))
      .mockResolvedValueOnce(htmlResponse('<html><head><meta property="og:title" content="Final"></head></html>'));
    const result = await fetchOg('https://example.test/start', { fetchImpl, dnsLookup: allowLookup() });
    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' && result.meta.title).toBe('Final');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('re-validates SSRF + scheme on every redirect hop', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(redirectResponse('https://example.test/hop1')).mockResolvedValueOnce(htmlResponse('<html></html>'));
    const dnsLookup = allowLookup();
    await fetchOg('https://example.test/start', { fetchImpl, dnsLookup });
    expect(dnsLookup).toHaveBeenCalledTimes(2);
  });

  it('rejects a redirect chain exceeding the 3-hop cap', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(redirectResponse('https://example.test/hop1'))
      .mockResolvedValueOnce(redirectResponse('https://example.test/hop2'))
      .mockResolvedValueOnce(redirectResponse('https://example.test/hop3'))
      .mockResolvedValueOnce(redirectResponse('https://example.test/hop4'));
    const result = await fetchOg('https://example.test/start', { fetchImpl, dnsLookup: allowLookup() });
    expect(result).toEqual({ kind: 'error', code: 'http-error', httpStatus: 302 });
    // Initial + 3 redirects followed = 4 calls; the 4th redirect is rejected without a 5th call.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('rejects a redirect with no Location header', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('', { status: 302 }));
    const result = await fetchOg('https://example.test/start', { fetchImpl, dnsLookup: allowLookup() });
    expect(result).toEqual({ kind: 'error', code: 'http-error', httpStatus: 302 });
  });

  it('blocks a redirect Location whose scheme is not http(s)', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(redirectResponse('javascript:alert(1)'));
    const result = await fetchOg('https://example.test/start', { fetchImpl, dnsLookup: allowLookup() });
    expect(result).toEqual({ kind: 'error', code: 'bad-scheme' });
  });

  it('cancels (drains) the redirect response body before following the next hop, instead of leaving it unconsumed', async () => {
    const redirect = redirectResponse('https://example.test/hop1');
    const cancelSpy = jest.spyOn(redirect.body as ReadableStream, 'cancel');
    const fetchImpl = jest.fn().mockResolvedValueOnce(redirect).mockResolvedValueOnce(htmlResponse('<html></html>'));
    await fetchOg('https://example.test/start', { fetchImpl, dnsLookup: allowLookup() });
    expect(cancelSpy).toHaveBeenCalled();
  });
});

describe('fetchOg — scheme / timeout / network / HTTP-error / size-cap failures', () => {
  it('treats a non-HTML content-type as a safe-failure error, NOT a successful degrade (AC-3)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('binary', { status: 200, headers: { 'content-type': 'application/pdf' } }));
    const result = await fetchOg('https://example.test/file.pdf', { fetchImpl, dnsLookup: allowLookup() });
    expect(result).toEqual({ kind: 'error', code: 'unsupported-content-type' });
  });

  it('rejects a non-http(s) scheme without calling fetch', async () => {
    const fetchImpl = jest.fn();
    const result = await fetchOg('ftp://example.test/file', { fetchImpl });
    expect(result).toEqual({ kind: 'error', code: 'bad-scheme' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an unparsable URL', async () => {
    const fetchImpl = jest.fn();
    const result = await fetchOg('not a url at all', { fetchImpl });
    expect(result).toEqual({ kind: 'error', code: 'bad-scheme' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('classifies an abort as a timeout', async () => {
    const fetchImpl = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    jest.useFakeTimers();
    try {
      const promise = fetchOg('https://example.test/slow', { fetchImpl, dnsLookup: allowLookup() });
      await jest.advanceTimersByTimeAsync(5_000);
      const result = await promise;
      expect(result).toEqual({ kind: 'error', code: 'timeout' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('classifies a hanging DNS lookup as a timeout — the deadline covers the SSRF/DNS check, not just fetch() (reviewer finding)', async () => {
    const fetchImpl = jest.fn();
    // A `dnsLookup` that never settles on its own — only the deadline
    // (via `raceAbort`) can make `fetchOg` resolve.
    const hangingLookup = jest.fn().mockImplementation(() => new Promise(() => undefined));
    jest.useFakeTimers();
    try {
      const promise = fetchOg('https://internal.example.test/', { fetchImpl, dnsLookup: hangingLookup });
      await jest.advanceTimersByTimeAsync(5_000);
      const result = await promise;
      expect(result).toEqual({ kind: 'error', code: 'timeout' });
      // The hung DNS lookup must never let a fetch() slip through.
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('classifies a non-abort fetch rejection as a network error', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const result = await fetchOg('https://example.test/page', { fetchImpl, dnsLookup: allowLookup() });
    expect(result).toEqual({ kind: 'error', code: 'network' });
  });

  it('classifies a 404 as an http-error with the status attached', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('not found', { status: 404 }));
    const result = await fetchOg('https://example.test/missing', { fetchImpl, dnsLookup: allowLookup() });
    expect(result).toEqual({ kind: 'error', code: 'http-error', httpStatus: 404 });
  });

  it('classifies a 500 as an http-error with the status attached', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const result = await fetchOg('https://example.test/broken', { fetchImpl, dnsLookup: allowLookup() });
    expect(result).toEqual({ kind: 'error', code: 'http-error', httpStatus: 500 });
  });

  it('parses a numeric-seconds Retry-After header on a 429', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '30' } }));
    const result = await fetchOg('https://example.test/too-many', { fetchImpl, dnsLookup: allowLookup() });
    expect(result).toEqual({ kind: 'error', code: 'http-error', httpStatus: 429, retryAfterSec: 30 });
  });

  it('parses an HTTP-date Retry-After header on a 429', async () => {
    const future = new Date(Date.now() + 45_000);
    const fetchImpl = jest.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': future.toUTCString() } }));
    const result = await fetchOg('https://example.test/too-many-date', { fetchImpl, dnsLookup: allowLookup() });
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.retryAfterSec).toBeGreaterThanOrEqual(44);
    expect(result.kind === 'error' && result.retryAfterSec).toBeLessThanOrEqual(46);
  });

  it('leaves retryAfterSec undefined on a 429 with no Retry-After header', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('', { status: 429 }));
    const result = await fetchOg('https://example.test/too-many-no-header', { fetchImpl, dnsLookup: allowLookup() });
    expect(result).toEqual({ kind: 'error', code: 'http-error', httpStatus: 429 });
  });

  it('parses Retry-After for a non-429 status too — extraction is unconditional, WHICH statuses honour it is toRenderError policy', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('', { status: 503, headers: { 'retry-after': '30' } }));
    const result = await fetchOg('https://example.test/unavailable', { fetchImpl, dnsLookup: allowLookup() });
    expect(result).toEqual({ kind: 'error', code: 'http-error', httpStatus: 503, retryAfterSec: 30 });
  });

  it('passes an absurdly large numeric Retry-After through un-clamped — the cache core clamps every plugin TTL at its own boundary (clampTtl/MAX_TTL_SEC)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': String(60 * 60 * 24 * 365) } }));
    const result = await fetchOg('https://example.test/too-many-huge', { fetchImpl, dnsLookup: allowLookup() });
    expect(result).toEqual({ kind: 'error', code: 'http-error', httpStatus: 429, retryAfterSec: 60 * 60 * 24 * 365 });
  });

  it('discards a Retry-After digit string too large to be a safe integer', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '9'.repeat(30) } }));
    const result = await fetchOg('https://example.test/too-many-unsafe', { fetchImpl, dnsLookup: allowLookup() });
    expect(result).toEqual({ kind: 'error', code: 'http-error', httpStatus: 429 });
  });

  it('passes an HTTP-date Retry-After far in the future through un-clamped (core boundary clamps it)', async () => {
    const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 10); // 10 years out
    const fetchImpl = jest.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': farFuture.toUTCString() } }));
    const result = await fetchOg('https://example.test/too-many-date-huge', { fetchImpl, dnsLookup: allowLookup() });
    expect(result.kind).toBe('error');
    const tenYearsSec = 60 * 60 * 24 * 365 * 10;
    expect(result.kind === 'error' && result.retryAfterSec).toBeGreaterThan(tenYearsSec - 60);
    expect(result.kind === 'error' && result.retryAfterSec).toBeLessThanOrEqual(tenYearsSec + 60);
  });

  it('rejects a response body larger than the 512KB cap', async () => {
    const oversized = `<html><head><meta property="og:title" content="x"></head><body>${'a'.repeat(600 * 1024)}</body></html>`;
    const fetchImpl = jest.fn().mockResolvedValue(htmlResponse(oversized));
    const result = await fetchOg('https://example.test/huge', { fetchImpl, dnsLookup: allowLookup() });
    expect(result).toEqual({ kind: 'error', code: 'too-large' });
  });

  it('accepts a response body right at the cap boundary', async () => {
    // Comfortably under 512KB with room for the meta tag + markup.
    const html = `<html><head><meta property="og:title" content="x"></head><body>${'a'.repeat(400 * 1024)}</body></html>`;
    const fetchImpl = jest.fn().mockResolvedValue(htmlResponse(html));
    const result = await fetchOg('https://example.test/big-but-ok', { fetchImpl, dnsLookup: allowLookup() });
    expect(result.kind).toBe('ok');
  });
});

describe('fetchOg — concurrency cap', () => {
  it(`never runs more than ${FETCH_CONCURRENCY_LIMIT} fetches at once`, async () => {
    const semaphore = new Semaphore(FETCH_CONCURRENCY_LIMIT, FETCH_QUEUE_LIMIT, FETCH_QUEUE_WAIT_MS);
    let concurrent = 0;
    let maxConcurrent = 0;
    const releasers: Array<() => void> = [];
    const fetchImpl = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          releasers.push(() => {
            concurrent--;
            resolve(htmlResponse('<html></html>'));
          });
        }),
    );
    const dnsLookup = allowLookup();
    const TOTAL = 12;
    const calls = Array.from({ length: TOTAL }, (_, i) => fetchOg(`https://example.test/${i}`, { fetchImpl, dnsLookup, semaphore }));

    await flush();
    await flush();
    expect(concurrent).toBe(FETCH_CONCURRENCY_LIMIT);
    expect(maxConcurrent).toBe(FETCH_CONCURRENCY_LIMIT);

    // Drain: release whatever is in flight, flush, repeat until every call
    // has been dispatched to `fetchImpl` at least once. The cap must never
    // be exceeded at any point along the way.
    while (fetchImpl.mock.calls.length < TOTAL || releasers.length > 0) {
      const release = releasers.shift();
      release?.();
      await flush();
      expect(maxConcurrent).toBeLessThanOrEqual(FETCH_CONCURRENCY_LIMIT);
    }
    await Promise.all(calls);
    expect(fetchImpl).toHaveBeenCalledTimes(TOTAL);
    expect(maxConcurrent).toBe(FETCH_CONCURRENCY_LIMIT);
  });
});

/**
 * `fetchImpl` stand-in for a host that never responds on its own — the
 * only way it ever settles is via `fetch-og.ts`'s own client-side
 * `AbortController` firing after `FETCH_TIMEOUT_MS` (mirroring the
 * "abort" test above), matching a real unresponsive/slow attacker host.
 */
function hangingFetchImpl(onCall?: () => void, onAbort?: () => void): jest.Mock {
  return jest.fn((_url: string, init?: RequestInit) => {
    onCall?.();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        onAbort?.();
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  });
}

describe('fetchOg — bounded wait queue (busy) — feature-link-card-fetch-queue-bound / crowi-review CROWI-REVIEW-002', () => {
  it('rejects busy synchronously (no timer needed) once active+queued reaches the cap — the overflow is never queued as a new unresolved Promise (AC1)', async () => {
    jest.useFakeTimers();
    try {
      const semaphore = new Semaphore(2, 3, 10_000); // max 2 active, queue cap 3 → total cap 5
      const dnsLookup = allowLookup();
      const fetchImpl = hangingFetchImpl();

      let settledCount = 0;
      const pending = Array.from({ length: 5 }, (_, i) => {
        const p = fetchOg(`https://93.184.216.${i + 1}/pending`, { fetchImpl, dnsLookup, semaphore });
        p.then(() => {
          settledCount++;
        });
        return p;
      });

      // Drain the dns-lookup microtasks (no clock movement) so the 5
      // within-cap calls have settled into "2 active + 3 queued".
      await jest.advanceTimersByTimeAsync(0);

      // The 6th request exceeds active(2)+queueLimit(3)=5 and must
      // resolve to busy immediately — proving it was never pushed onto
      // the wait queue as a pending Promise at all.
      const overflow = await fetchOg('https://93.184.216.6/overflow', { fetchImpl, dnsLookup, semaphore });
      expect(overflow).toEqual({ kind: 'error', code: 'busy' });
      expect(settledCount).toBe(0); // none of the within-cap 5 have settled yet

      // Drain everything so no fake timers dangle into a later test.
      await jest.advanceTimersByTimeAsync(20_000);
      await Promise.all(pending);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a queued request fails with busy once its own wait deadline elapses — independent of the post-acquisition fetch timeout (AC2)', async () => {
    jest.useFakeTimers();
    try {
      const semaphore = new Semaphore(1, 1, 1_000); // 1 active slot, 1 queue slot, 1s wait timeout
      const dnsLookup = allowLookup();
      const fetchImpl = hangingFetchImpl();

      const active = fetchOg('https://93.184.216.10/active', { fetchImpl, dnsLookup, semaphore });
      await jest.advanceTimersByTimeAsync(0); // let the active acquisition's dns lookup settle
      const queued = fetchOg('https://93.184.216.11/queued', { fetchImpl, dnsLookup, semaphore });

      // Cross the 1s wait deadline — the queued request must fail with
      // busy even though the active holder's own 5s fetch timeout
      // hasn't fired yet (it's still occupying the only slot).
      await jest.advanceTimersByTimeAsync(1_000);
      await expect(queued).resolves.toEqual({ kind: 'error', code: 'busy' });

      // The active holder only frees up via its own (unrelated) 5s
      // post-acquisition fetch timeout.
      await jest.advanceTimersByTimeAsync(5_000);
      await expect(active).resolves.toEqual({ kind: 'error', code: 'timeout' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('once a slot frees up, a fresh request is retried and can succeed — busy is never permanent (AC6)', async () => {
    const semaphore = new Semaphore(1, 1, 5_000);
    const dnsLookup = allowLookup();

    let releaseFirst: (() => void) | undefined;
    const firstFetchImpl = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseFirst = () => resolve(htmlResponse('<html></html>'));
        }),
    );
    const first = fetchOg('https://93.184.216.20/first', { fetchImpl: firstFetchImpl, dnsLookup, semaphore });
    await flush();
    expect(firstFetchImpl).toHaveBeenCalledTimes(1);

    const secondFetchImpl = jest.fn().mockResolvedValue(htmlResponse('<html><head><meta property="og:title" content="Second"></head></html>'));
    const second = fetchOg('https://93.184.216.21/second', { fetchImpl: secondFetchImpl, dnsLookup, semaphore });
    await flush();
    expect(secondFetchImpl).not.toHaveBeenCalled(); // still queued — the only slot is held by `first`

    releaseFirst?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.kind).toBe('ok');
    expect(secondResult.kind).toBe('ok');
    expect(secondFetchImpl).toHaveBeenCalledTimes(1);
  });

  it(
    'DoS repro: a page dispatching many more unique slow-host @[card] fetches than the semaphore can hold ' +
      'still bounds concurrent fetches + total queued Promises and resolves the whole batch in bounded time (AC3)',
    async () => {
      jest.useFakeTimers();
      try {
        // The actual production bounds — proves the DoS is closed with
        // the real configured numbers, not just contrived small ones.
        const semaphore = new Semaphore(FETCH_CONCURRENCY_LIMIT, FETCH_QUEUE_LIMIT, FETCH_QUEUE_WAIT_MS);
        const dnsLookup = allowLookup();

        let concurrent = 0;
        let maxConcurrent = 0;
        const fetchImpl = hangingFetchImpl(
          () => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
          },
          () => {
            concurrent--;
          },
        );

        // 20 MORE unique-host embeds than the semaphore can ever admit
        // at once (FETCH_CONCURRENCY_LIMIT + FETCH_QUEUE_LIMIT = 55) —
        // simulates one malicious page's `Promise.all` embed dispatch
        // (`../embed-tags.ts`) across many unique, unresponsive hosts.
        const EXTRA_OVER_CAP = 20;
        const TOTAL = FETCH_CONCURRENCY_LIMIT + FETCH_QUEUE_LIMIT + EXTRA_OVER_CAP;

        let settledCount = 0;
        const calls = Array.from({ length: TOTAL }, (_, i) => {
          const p = fetchOg(`https://93.184.216.${(i % 250) + 1}/page-${i}`, { fetchImpl, dnsLookup, semaphore });
          p.then(() => {
            settledCount++;
          });
          return p;
        });

        // Let every dispatch's synchronous accept/queue/reject decision
        // run to completion before any clock advance — the queue-length
        // cap must reject the overflow WITHOUT any timer ever firing.
        await jest.advanceTimersByTimeAsync(0);

        // AC3(a): only the over-cap overflow has settled (busy) so far —
        // the count of still-unresolved dispatches from this one page
        // never exceeded FETCH_CONCURRENCY_LIMIT + FETCH_QUEUE_LIMIT.
        expect(settledCount).toBe(EXTRA_OVER_CAP);
        expect(TOTAL - settledCount).toBe(FETCH_CONCURRENCY_LIMIT + FETCH_QUEUE_LIMIT);
        expect(maxConcurrent).toBeLessThanOrEqual(FETCH_CONCURRENCY_LIMIT);

        // AC3(b): advance far enough for every accepted (active +
        // queued) request to resolve one way or another (fetch timeout
        // or queue-wait timeout) — bounded time, not indefinite.
        await jest.advanceTimersByTimeAsync(120_000);

        const results = await Promise.all(calls);
        expect(settledCount).toBe(TOTAL); // every dispatch settled
        expect(results.every((r) => r.kind === 'error')).toBe(true); // every unresponsive host degrades to an error, never hangs
        expect(maxConcurrent).toBeLessThanOrEqual(FETCH_CONCURRENCY_LIMIT); // still holds after the full drain

        // AC3(c): the process/module is not wedged by the DoS attempt —
        // a fresh, fast request against the SAME (now-drained) shared
        // semaphore succeeds normally right after.
        const freshFetchImpl = jest.fn().mockResolvedValue(htmlResponse('<html><head><meta property="og:title" content="ok"></head></html>'));
        const fresh = await fetchOg('https://93.184.216.99/after', { fetchImpl: freshFetchImpl, dnsLookup, semaphore });
        expect(fresh.kind).toBe('ok');
      } finally {
        jest.useRealTimers();
      }
    },
  );
});

describe('extractOgMeta', () => {
  it('prefers the first occurrence when a property is duplicated', () => {
    const html = '<meta property="og:title" content="First"><meta property="og:title" content="Second">';
    expect(extractOgMeta(html).title).toBe('First');
  });

  it('decodes HTML entities in extracted text', () => {
    const html = '<meta property="og:title" content="Fish &amp; Chips &lt;tasty&gt;">';
    expect(extractOgMeta(html).title).toBe('Fish & Chips <tasty>');
  });

  it('drops a non-http(s) og:image (data: URL) rather than emitting it', () => {
    const html = '<meta property="og:image" content="data:image/png;base64,AAAA">';
    expect(extractOgMeta(html).image).toBeUndefined();
  });

  it('drops a javascript: og:image', () => {
    const html = '<meta property="og:image" content="javascript:alert(1)">';
    expect(extractOgMeta(html).image).toBeUndefined();
  });

  it('keeps an absolute https og:image', () => {
    const html = '<meta property="og:image" content="https://example.test/img.png">';
    expect(extractOgMeta(html).image).toBe('https://example.test/img.png');
  });

  it('reads single-quoted attribute values', () => {
    const html = "<meta property='og:title' content='Single quoted'>";
    expect(extractOgMeta(html).title).toBe('Single quoted');
  });

  it('returns an empty meta object for a page with no recognised tags', () => {
    expect(extractOgMeta('<html><head></head><body>hi</body></html>')).toEqual({
      title: undefined,
      description: undefined,
      image: undefined,
      siteName: undefined,
    });
  });
});
