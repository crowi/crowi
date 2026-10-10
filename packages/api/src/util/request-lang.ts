export type RequestLang = 'en' | 'ja';

const SUPPORTED: readonly string[] = ['en', 'ja'];
const LOCALE_COOKIE = 'PARAGLIDE_LOCALE';

const toSupported = (tag: string | null | undefined): RequestLang | null => {
  if (!tag) return null;
  const base = tag.trim().toLowerCase().replace('_', '-').split('-')[0];
  return SUPPORTED.includes(base) ? (base as RequestLang) : null;
};

const fromCookie = (header: string | null): RequestLang | null => {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === LOCALE_COOKIE) return toSupported(decodeURIComponent(rest.join('=')));
  }
  return null;
};

// Walks tags in the order the browser lists them: `ja-JP,ja;q=0.9,en;q=0.8`
// is already preference-ordered, and a q-value sort would only matter for
// clients that reorder them.
const fromAcceptLanguage = (header: string | null): RequestLang | null => {
  if (!header) return null;
  for (const entry of header.split(',')) {
    const found = toSupported(entry.split(';')[0]);
    if (found) return found;
  }
  return null;
};

/**
 * `User.lang` for an account created from a request. An explicit value the
 * client sent wins (only when it is in the User lang enum), then the web
 * app's locale cookie, then Accept-Language; anything else is `en`.
 */
export function resolveRequestLang(headers: Headers, explicit?: string | null): RequestLang {
  const exact = explicit && SUPPORTED.includes(explicit) ? (explicit as RequestLang) : null;
  return exact ?? fromCookie(headers.get('cookie')) ?? fromAcceptLanguage(headers.get('accept-language')) ?? 'en';
}
