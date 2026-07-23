import { errorPlaceholder, renderReservation, sizeLimitPlaceholder } from './reservation';

describe('renderReservation', () => {
  it('renders fixed variant with width and height', () => {
    const html = renderReservation({ variant: 'fixed', widthPx: 320, heightPx: 240 });
    expect(html).toContain('crowi-embed-placeholder-fixed');
    expect(html).toContain('width:320px');
    expect(html).toContain('height:240px');
  });

  it('renders fixed variant with height only when widthPx is omitted', () => {
    const html = renderReservation({ variant: 'fixed', heightPx: 100 });
    expect(html).toContain('height:100px');
    expect(html).not.toContain('width:');
  });

  it('clamps fixed dimensions to a sane range', () => {
    const html = renderReservation({ variant: 'fixed', widthPx: -10, heightPx: 10_000_000 });
    expect(html).toContain('width:0px');
    expect(html).toContain('height:4096px');
  });

  it('renders aspect variant with css aspect-ratio', () => {
    const html = renderReservation({ variant: 'aspect', aspectRatio: 16 / 9 });
    expect(html).toContain('crowi-embed-placeholder-aspect');
    expect(html).toMatch(/aspect-ratio:1\.7778/);
  });

  it('clamps invalid aspect ratios', () => {
    const html = renderReservation({ variant: 'aspect', aspectRatio: 0 });
    expect(html).toContain('aspect-ratio:1');
  });

  it('renders card variant with size class + height', () => {
    const small = renderReservation({ variant: 'card', size: 'small' });
    const medium = renderReservation({ variant: 'card', size: 'medium' });
    const large = renderReservation({ variant: 'card', size: 'large' });
    expect(small).toContain('crowi-embed-placeholder-card-small');
    expect(small).toContain('height:80px');
    expect(medium).toContain('crowi-embed-placeholder-card-medium');
    expect(medium).toContain('height:160px');
    expect(large).toContain('crowi-embed-placeholder-card-large');
    expect(large).toContain('height:280px');
  });
});

describe('errorPlaceholder', () => {
  const codes = ['auth', 'rate_limit', 'not_found', 'network', 'timeout', 'unknown', 'blocked', 'busy'] as const;

  it.each(codes)('renders %s error with the canonical class and label', (code) => {
    const html = errorPlaceholder(code, undefined);
    expect(html).toContain(`crowi-embed-placeholder-error-${code}`);
    expect(html).toContain('role="status"');
  });

  it('embeds the reservation shape if provided', () => {
    const html = errorPlaceholder('auth', { variant: 'fixed', heightPx: 120 });
    expect(html).toContain('crowi-embed-placeholder-fixed');
    expect(html).toContain('height:120px');
  });
});

describe('sizeLimitPlaceholder', () => {
  it('produces a status placeholder for entry-too-large', () => {
    const html = sizeLimitPlaceholder('entry-too-large', undefined);
    expect(html).toContain('crowi-embed-placeholder-error-size-limit');
    expect(html).toContain('data-reason="entry-too-large"');
  });

  it('produces a status placeholder for page-quota-exceeded', () => {
    const html = sizeLimitPlaceholder('page-quota-exceeded', { variant: 'aspect', aspectRatio: 16 / 9 });
    expect(html).toContain('crowi-embed-placeholder-error-size-limit');
    expect(html).toContain('data-reason="page-quota-exceeded"');
    expect(html).toContain('crowi-embed-placeholder-aspect');
  });
});
