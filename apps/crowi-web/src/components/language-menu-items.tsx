'use client';

import { Check, Languages } from 'lucide-react';
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { getLocale, setLocale, locales } from '@/paraglide/runtime.js';
import { m } from '@/paraglide/messages.js';

const LOCALE_LABELS: Record<string, () => string> = {
  ja: () => m['header.language_ja'](),
  en: () => m['header.language_en'](),
};

/**
 * Renders a "Language" section + one item per supported locale, suitable for
 * dropping into the user dropdown menu in (auth) / (admin) layouts.
 *
 * `setLocale` writes the PARAGLIDE_LOCALE cookie and reloads the page so
 * Server Components re-render with the new strings.
 */
export function LanguageMenuItems() {
  const current = getLocale();

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Languages className="h-3.5 w-3.5" />
        {m['header.language_section']()}
      </DropdownMenuLabel>
      {locales.map((locale) => {
        const label = LOCALE_LABELS[locale]?.() ?? locale;
        const isActive = locale === current;
        return (
          <DropdownMenuItem key={locale} onClick={() => setLocale(locale)} className="flex items-center gap-2">
            {isActive ? <Check className="h-4 w-4 text-primary" /> : <span className="h-4 w-4" aria-hidden />}
            {label}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
