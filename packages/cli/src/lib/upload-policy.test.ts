import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UploadPolicyResponse } from '@crowi/api-contract';

import { ADHOC_ALIAS, loadConfig, type Profile, upsertProfile } from './config';
import { fetchUploadPolicy, resolveDeclaredMediaType } from './upload-policy';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

const POLICY: UploadPolicyResponse = {
  allowedMimeTypes: ['image/png', 'application/pdf', 'application/octet-stream'],
  extensionHints: { png: 'image/png', pdf: 'application/pdf' },
  maxBytes: { attachment: 1000 },
  profilePicture: { allowedMimeTypes: ['image/png'], maxBytes: 100 },
};

describe('fetchUploadPolicy', () => {
  let tmpRoot: string;
  let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit]>;
  const originalFetch = global.fetch;
  const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'crowi-cli-upload-policy-'));
    process.env.XDG_CONFIG_HOME = tmpRoot;
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (ORIGINAL_XDG === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
    }
    global.fetch = originalFetch;
  });

  it('fetches and persists the policy (with a fetch time) on a named profile', async () => {
    upsertProfile({ alias: 'work', endpoint: 'https://wiki.example.com', tokens: { accessToken: 'pat-1' } });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, POLICY));

    const started = loadConfig().profiles.work;
    const before = Date.now();
    const policy = await fetchUploadPolicy(started);

    expect(policy).toEqual(POLICY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = loadConfig().profiles.work;
    expect(stored.uploadPolicy).toEqual(POLICY);
    expect(stored.uploadPolicyFetchedAt).toBeGreaterThanOrEqual(before);
  });

  it('AC-7: does not re-fetch a policy that is still within its TTL — reads it straight from the profile object', async () => {
    // Simulates the SECOND CLI invocation, made shortly after the first: the
    // profile object handed in already carries `uploadPolicy` +
    // `uploadPolicyFetchedAt` (as `resolveProfile` would read it back from
    // `contexts.json`), so no request should be made at all.
    const cached: Profile = {
      alias: 'work',
      endpoint: 'https://wiki.example.com',
      tokens: { accessToken: 'pat-1' },
      uploadPolicy: POLICY,
      uploadPolicyFetchedAt: Date.now(),
    };

    const policy = await fetchUploadPolicy(cached);

    expect(policy).toEqual(POLICY);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a cached policy with no recorded fetch time as stale, refetches, and persists the new value + fetch time', async () => {
    // A profile that predates `uploadPolicyFetchedAt` (or a hand-edited
    // config) has `uploadPolicy` set but no timestamp — `isUploadPolicyFresh`
    // treats a missing timestamp as stale rather than as "fresh forever".
    upsertProfile({ alias: 'work', endpoint: 'https://wiki.example.com', tokens: { accessToken: 'pat-1' }, uploadPolicy: POLICY });
    const updated: UploadPolicyResponse = { ...POLICY, maxBytes: { ...POLICY.maxBytes, attachment: 999 } };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, updated));

    const started = loadConfig().profiles.work;
    const policy = await fetchUploadPolicy(started);

    expect(policy).toEqual(updated);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = loadConfig().profiles.work;
    expect(stored.uploadPolicy).toEqual(updated);
    expect(stored.uploadPolicyFetchedAt).toEqual(expect.any(Number));
  });

  it('treats a cached policy past its TTL as stale and refetches', async () => {
    const staleFetchedAt = Date.now() - 11 * 60 * 1000; // TTL is 10 minutes.
    upsertProfile({
      alias: 'work',
      endpoint: 'https://wiki.example.com',
      tokens: { accessToken: 'pat-1' },
      uploadPolicy: POLICY,
      uploadPolicyFetchedAt: staleFetchedAt,
    });
    const updated: UploadPolicyResponse = { ...POLICY, allowedMimeTypes: [...POLICY.allowedMimeTypes, 'image/heic'] };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, updated));

    const started = loadConfig().profiles.work;
    const policy = await fetchUploadPolicy(started);

    expect(policy).toEqual(updated);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loadConfig().profiles.work.uploadPolicyFetchedAt).toBeGreaterThan(staleFetchedAt);
  });

  it('on a stale cache, degrades to the STALE CACHED policy (not null) when the refetch fails, without persisting a new fetch time', async () => {
    const staleFetchedAt = Date.now() - 11 * 60 * 1000;
    upsertProfile({
      alias: 'work',
      endpoint: 'https://wiki.example.com',
      tokens: { accessToken: 'pat-1' },
      uploadPolicy: POLICY,
      uploadPolicyFetchedAt: staleFetchedAt,
    });
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const started = loadConfig().profiles.work;
    const policy = await fetchUploadPolicy(started);

    // The stale value is still better than falling back to the local table
    // (and definitely better than null) for a single transient failure.
    expect(policy).toEqual(POLICY);
    const stored = loadConfig().profiles.work;
    expect(stored.uploadPolicy).toEqual(POLICY);
    expect(stored.uploadPolicyFetchedAt).toBe(staleFetchedAt);
  });

  it('on a stale cache, a 404 still persists the null sentinel unconditionally, overriding the previously cached policy', async () => {
    const staleFetchedAt = Date.now() - 11 * 60 * 1000;
    upsertProfile({
      alias: 'work',
      endpoint: 'https://wiki.example.com',
      tokens: { accessToken: 'pat-1' },
      uploadPolicy: POLICY,
      uploadPolicyFetchedAt: staleFetchedAt,
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(404, undefined));

    const started = loadConfig().profiles.work;
    const policy = await fetchUploadPolicy(started);

    expect(policy).toBeNull();
    expect(loadConfig().profiles.work.uploadPolicy).toBeNull();
  });

  it('AC-7: a 404 (old server) resolves to null, is recorded as a persisted sentinel, and is never re-fetched on the next invocation', async () => {
    upsertProfile({ alias: 'work', endpoint: 'https://wiki.example.com', tokens: { accessToken: 'pat-1' } });
    fetchMock.mockResolvedValueOnce(jsonResponse(404, undefined));

    const started = loadConfig().profiles.work;
    const policy = await fetchUploadPolicy(started);

    expect(policy).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // `null`, not `undefined` — the sentinel that says "confirmed absent".
    expect(loadConfig().profiles.work.uploadPolicy).toBeNull();

    // Next invocation: the profile object now carries the persisted `null`
    // sentinel (as `resolveProfile` would read it back), so no new request.
    const reloaded = loadConfig().profiles.work;
    const second = await fetchUploadPolicy(reloaded);
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('degrades to null WITHOUT persisting a sentinel on a non-404 failure (network error), so a later invocation retries', async () => {
    upsertProfile({ alias: 'work', endpoint: 'https://wiki.example.com', tokens: { accessToken: 'pat-1' } });
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const started = loadConfig().profiles.work;
    const policy = await fetchUploadPolicy(started);

    expect(policy).toBeNull();
    // Nothing persisted — a transient failure must not look like a
    // confirmed-old-server 404 on the next invocation.
    expect(loadConfig().profiles.work.uploadPolicy).toBeUndefined();
  });

  it('degrades to null WITHOUT persisting a sentinel on a 500', async () => {
    upsertProfile({ alias: 'work', endpoint: 'https://wiki.example.com', tokens: { accessToken: 'pat-1' } });
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: { message: 'boom' } }));

    const started = loadConfig().profiles.work;
    const policy = await fetchUploadPolicy(started);

    expect(policy).toBeNull();
    expect(loadConfig().profiles.work.uploadPolicy).toBeUndefined();
  });

  it('never persists anything for an ad-hoc (--url/--token) profile', async () => {
    const adhoc: Profile = { alias: ADHOC_ALIAS, endpoint: 'https://wiki.example.com', tokens: { accessToken: 'one-shot-pat' } };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, POLICY));

    const policy = await fetchUploadPolicy(adhoc);

    expect(policy).toEqual(POLICY);
    expect(loadConfig().profiles[ADHOC_ALIAS]).toBeUndefined();
  });

  it('treats a malformed 200 body as no policy, without throwing', async () => {
    upsertProfile({ alias: 'work', endpoint: 'https://wiki.example.com', tokens: { accessToken: 'pat-1' } });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { not: 'a policy' }));

    const started = loadConfig().profiles.work;
    await expect(fetchUploadPolicy(started)).resolves.toBeNull();
    expect(loadConfig().profiles.work.uploadPolicy).toBeUndefined();
  });
});

describe('resolveDeclaredMediaType', () => {
  it('AC-7: prefers the policy extensionHints over the local table when a policy is present', async () => {
    // The api and CLI extension tables are currently byte-identical (see
    // media-type.ts), so no real extension can distinguish "answered
    // from the policy" from "silently fell back to the local table" — every
    // shared extension resolves to the same value either way. Diverge the
    // fixture's `.pdf` mapping from the local table's real value instead, so
    // a fallback bug would produce the wrong (local-table) answer here.
    const policyWithDivergentPdf: UploadPolicyResponse = {
      ...POLICY,
      extensionHints: { ...POLICY.extensionHints, pdf: 'application/x-policy-pdf-test-marker' },
    };
    expect(resolveDeclaredMediaType('report.pdf', policyWithDivergentPdf)).toBe('application/x-policy-pdf-test-marker');
  });

  it('is case-insensitive about the extension when a policy is present', () => {
    expect(resolveDeclaredMediaType('SHOT.PNG', POLICY)).toBe('image/png');
  });

  it('does NOT fall back to the local table for an extension the policy does not list — declares octet-stream instead', () => {
    // `.jpg` is not in POLICY.extensionHints, even though the local table
    // knows it — a server that answered the policy request is authoritative.
    expect(resolveDeclaredMediaType('photo.jpg', POLICY)).toBe('application/octet-stream');
  });

  it('falls back to the local media-type.ts table when there is no policy (old server)', () => {
    expect(resolveDeclaredMediaType('photo.jpg', null)).toBe('image/jpeg');
    expect(resolveDeclaredMediaType('thing.qqq', null)).toBe('application/octet-stream');
  });
});
