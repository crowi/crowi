import { checkHostnameSsrf } from './ssrf-guard';

describe('checkHostnameSsrf — IP literal hostnames', () => {
  it.each([
    ['10.0.0.1', 'RFC1918 10.0.0.0/8'],
    ['172.16.0.1', 'RFC1918 172.16.0.0/12 (low end)'],
    ['172.31.255.255', 'RFC1918 172.16.0.0/12 (high end)'],
    ['192.168.1.1', 'RFC1918 192.168.0.0/16'],
    ['127.0.0.1', 'loopback'],
    ['127.53.0.1', 'loopback (127.0.0.0/8, not just .1)'],
    ['169.254.169.254', 'cloud metadata address'],
    ['169.254.1.1', 'link-local'],
    ['0.0.0.0', '"this network"'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['198.51.100.1', 'TEST-NET-2'],
    ['203.0.113.1', 'TEST-NET-3'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
  ])('blocks IPv4 %s (%s)', async (ip) => {
    const result = await checkHostnameSsrf(ip);
    expect(result.allowed).toBe(false);
  });

  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fe80::abcd:1234', 'link-local (non-trivial suffix)'],
    ['fc00::1', 'unique-local (fc00::/7 low end)'],
    ['fd12:3456:789a::1', 'unique-local (fd00::/8, common operator range)'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:10.0.0.1', 'IPv4-mapped RFC1918'],
    ['::ffff:169.254.169.254', 'IPv4-mapped cloud metadata'],
  ])('blocks IPv6 %s (%s)', async (ip) => {
    const result = await checkHostnameSsrf(ip);
    expect(result.allowed).toBe(false);
  });

  it.each([
    ['8.8.8.8', 'public IPv4'],
    ['93.184.216.34', 'public IPv4 (example.com-class)'],
    ['2001:4860:4860::8888', 'public IPv6'],
  ])('allows public address literal %s (%s)', async (ip) => {
    const result = await checkHostnameSsrf(ip);
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.address).toBe(ip);
  });
});

describe('checkHostnameSsrf — DNS-resolved hostnames (rebinding vector)', () => {
  it('blocks a hostname whose DNS lookup resolves to a private IPv4 address', async () => {
    const fakeLookup = jest.fn().mockResolvedValue({ address: '10.1.2.3', family: 4 });
    const result = await checkHostnameSsrf('internal.example.test', fakeLookup);
    expect(result.allowed).toBe(false);
    expect(fakeLookup).toHaveBeenCalledWith('internal.example.test');
  });

  it('blocks a hostname whose DNS lookup resolves to the cloud metadata address', async () => {
    const fakeLookup = jest.fn().mockResolvedValue({ address: '169.254.169.254', family: 4 });
    const result = await checkHostnameSsrf('metadata.internal.example.test', fakeLookup);
    expect(result.allowed).toBe(false);
  });

  it('blocks a hostname whose DNS lookup resolves to an IPv6 loopback address', async () => {
    const fakeLookup = jest.fn().mockResolvedValue({ address: '::1', family: 6 });
    const result = await checkHostnameSsrf('sneaky.example.test', fakeLookup);
    expect(result.allowed).toBe(false);
  });

  it('allows a hostname whose DNS lookup resolves to a public address', async () => {
    const fakeLookup = jest.fn().mockResolvedValue({ address: '93.184.216.34', family: 4 });
    const result = await checkHostnameSsrf('example.test', fakeLookup);
    expect(result.allowed).toBe(true);
  });

  it('fails closed (blocked) when the DNS lookup itself rejects', async () => {
    const fakeLookup = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const result = await checkHostnameSsrf('does-not-resolve.example.test', fakeLookup);
    expect(result.allowed).toBe(false);
  });

  it('does not consult DNS at all for an IP literal (private ranges are rejected purely syntactically)', async () => {
    const fakeLookup = jest.fn();
    const result = await checkHostnameSsrf('127.0.0.1', fakeLookup);
    expect(result.allowed).toBe(false);
    expect(fakeLookup).not.toHaveBeenCalled();
  });
});

describe('checkHostnameSsrf — bracketed IPv6 literals (WHATWG `URL.hostname` shape)', () => {
  it('allows a bracketed public IPv6 literal (e.g. `new URL(...).hostname`) without a DNS lookup', async () => {
    const fakeLookup = jest.fn();
    const result = await checkHostnameSsrf('[2001:4860:4860::8888]', fakeLookup);
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.address).toBe('2001:4860:4860::8888');
    expect(fakeLookup).not.toHaveBeenCalled();
  });

  it('blocks a bracketed loopback IPv6 literal', async () => {
    const result = await checkHostnameSsrf('[::1]');
    expect(result.allowed).toBe(false);
  });

  it('blocks a bracketed IPv4-mapped metadata IPv6 literal', async () => {
    const result = await checkHostnameSsrf('[::ffff:169.254.169.254]');
    expect(result.allowed).toBe(false);
  });
});

describe('checkHostnameSsrf — malformed input fails closed', () => {
  it('blocks a syntactically invalid IPv6-looking literal', async () => {
    // `net.isIP` returns 0 for this (not recognised as a literal), so it
    // falls through to the DNS path; a malformed "address" a lookup
    // shouldn't plausibly return is treated as blocked defensively.
    const fakeLookup = jest.fn().mockResolvedValue({ address: 'not-an-ip', family: 4 });
    const result = await checkHostnameSsrf('weird.example.test', fakeLookup);
    expect(result.allowed).toBe(false);
  });
});
