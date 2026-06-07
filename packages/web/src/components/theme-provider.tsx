'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ComponentProps } from 'react';

/**
 * Thin wrapper around next-themes' provider with Crowi's defaults baked in:
 * - `attribute="class"` toggles the `.dark` class on <html>, matching the
 *   Tailwind v4 `@custom-variant dark (&:is(.dark *))` in globals.css and the
 *   `:root` / `.dark` token sets.
 * - `defaultTheme="system"` + `enableSystem` follows the OS setting until the
 *   user picks an explicit theme (persisted to localStorage by next-themes).
 * - `disableTransitionOnChange` avoids color-transition flicker on toggle.
 *
 * The blocking inline script next-themes injects prevents FOUC on reload;
 * the matching `<html suppressHydrationWarning>` (layout.tsx) silences the
 * class-injection hydration diff.
 */
export function ThemeProvider({ children, ...props }: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange {...props}>
      {children}
    </NextThemesProvider>
  );
}
