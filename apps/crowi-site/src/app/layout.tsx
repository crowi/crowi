import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './global.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://crowi.wiki'),
  title: {
    default: 'Crowi — Markdown-based Wiki for Teams',
    template: '%s | Crowi',
  },
  description: 'Crowi is a Markdown-based wiki application for team knowledge sharing.',
};

/*
 * Pass-through root layout. The actual <html>/<body> live in
 * `[lang]/layout.tsx` so locale can drive `<html lang>`. The bare `/`
 * route is handled by `app/page.tsx`, which renders its own minimal
 * HTML for the locale picker — it never inherits children from here.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
