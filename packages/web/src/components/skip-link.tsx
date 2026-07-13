import { m } from '@paraglide/messages.js';
import { MAIN_CONTENT_ID } from '@/lib/use-route-focus';

/**
 * Skip-link — visually hidden until keyboard-focused, lets a keyboard user
 * jump past the header (and, in the (auth) shell, search) without tabbing
 * through it on every page. Shared by the (auth) and (admin) app shells so
 * the two identical instances can't drift; each renders it as the first
 * focusable element, targeting `<main id={MAIN_CONTENT_ID}>`.
 */
export function SkipLink() {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {m['a11y.skip_to_content']()}
    </a>
  );
}
