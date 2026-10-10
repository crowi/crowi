import { resolveRequestLang } from './request-lang';

const headers = (h: Record<string, string>) => new Headers(h);

describe('resolveRequestLang', () => {
  it('prefers a valid explicit lang over cookie and Accept-Language', () => {
    expect(resolveRequestLang(headers({ cookie: 'PARAGLIDE_LOCALE=en', 'accept-language': 'en' }), 'ja')).toBe('ja');
  });

  it('ignores an explicit lang outside the User lang enum', () => {
    expect(resolveRequestLang(headers({}), 'fr')).toBe('en');
  });

  it('falls back to the PARAGLIDE_LOCALE cookie', () => {
    expect(resolveRequestLang(headers({ cookie: 'a=b; PARAGLIDE_LOCALE=ja' }))).toBe('ja');
  });

  it('falls back to Accept-Language, mapping regional tags to the base language', () => {
    expect(resolveRequestLang(headers({ 'accept-language': 'ja-JP,ja;q=0.9,en;q=0.8' }))).toBe('ja');
    expect(resolveRequestLang(headers({ 'accept-language': 'fr-FR,en-US;q=0.5' }))).toBe('en');
  });

  it('defaults to en when nothing matches', () => {
    expect(resolveRequestLang(headers({}))).toBe('en');
    expect(resolveRequestLang(headers({ cookie: 'PARAGLIDE_LOCALE=zz', 'accept-language': 'fr' }))).toBe('en');
  });
});
