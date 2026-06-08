'use client';

import { useEffect } from 'react';

/**
 * Root-level error boundary. Renders only when the *root layout itself*
 * throws — i.e. the LocaleBridge / Providers tree never mounted. Because
 * Paraglide's runtime and the design-system providers are unavailable in
 * that state, this screen:
 *
 *  - renders its own `<html>` / `<body>` (it replaces the root layout), and
 *  - uses locale-agnostic, bilingual plain text with inline styles instead of
 *    `m['*']()` / Tailwind tokens, so it can't itself depend on anything that
 *    may have failed to initialise.
 *
 * This is intentionally minimal; the richer `error.tsx` handles the common
 * case (a segment throwing while the app shell is healthy).
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('Root layout error:', error);
  }, [error]);

  return (
    <html lang="ja">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#0f1720',
          color: '#e5e7eb',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          padding: '1rem',
        }}
      >
        <div style={{ maxWidth: '28rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.5rem' }}>問題が発生しました / Something went wrong</h1>
          <p style={{ fontSize: '0.875rem', lineHeight: 1.6, color: '#9ca3af', marginBottom: '1.5rem' }}>
            予期しないエラーが発生しました。ページを再読み込みしてください。
            <br />
            An unexpected error occurred. Please reload the page.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              cursor: 'pointer',
              border: 'none',
              borderRadius: '0.375rem',
              padding: '0.5rem 1rem',
              fontSize: '0.875rem',
              fontWeight: 500,
              backgroundColor: '#0d9488',
              color: '#ffffff',
            }}
          >
            再読み込み / Reload
          </button>
        </div>
      </body>
    </html>
  );
}
