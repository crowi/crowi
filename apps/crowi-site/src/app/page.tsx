import { defaultLocale, locales } from '@/lib/i18n';

/*
 * `/` doesn't render content. It picks a locale (browser preference
 * → defaultLocale fallback) and replaces history with `/<locale>`.
 * Done client-side because `output: 'export'` has no server runtime
 * and Cloudflare Pages `_redirects` is host-specific. A static HTML
 * refresh + inline JS works on any host.
 *
 * The root layout in `app/layout.tsx` is a pass-through, so this
 * page must render its own `<html>` and `<body>`.
 */
export default function RootIndex() {
  const langs = locales as readonly string[];
  const script = `(function(){try{var langs=${JSON.stringify(langs)};var pref=(navigator.languages&&navigator.languages[0])||navigator.language||'';var primary=pref.toLowerCase().split('-')[0];var m=langs.indexOf(primary)>=0?primary:${JSON.stringify(defaultLocale)};window.location.replace('/'+m+'/');}catch(e){window.location.replace(${JSON.stringify(`/${defaultLocale}/`)});}}());`;

  return (
    <html lang={defaultLocale}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Crowi</title>
        <meta httpEquiv="refresh" content={`0; url=/${defaultLocale}/`} />
        <script dangerouslySetInnerHTML={{ __html: script }} />
      </head>
      <body>
        <p style={{ fontFamily: 'sans-serif', textAlign: 'center', marginTop: '40vh' }}>
          Redirecting to <a href={`/${defaultLocale}/`}>/{defaultLocale}/</a>
        </p>
      </body>
    </html>
  );
}
