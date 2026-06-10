'use client';

import { getLocale, type Locale, locales, setLocale } from '@paraglide/runtime.js';
import { m } from '@paraglide/messages.js';
import { cn } from '@/lib/utils';

/** Native-name labels for each paraglide locale (kept in their own language). */
const LOCALE_LABELS: Record<Locale, string> = {
  ja: '日本語',
  en: 'English',
};

interface LocaleSwitcherProps {
  className?: string;
}

/**
 * Standalone language toggle for pre-auth screens (login / register / …),
 * where `LocaleSync` (which mirrors the signed-in user's `lang`) does not
 * run. Calls paraglide's `setLocale`, which persists the `PARAGLIDE_LOCALE`
 * cookie and reloads so Server Components re-render with the new strings.
 */
export function LocaleSwitcher({ className }: LocaleSwitcherProps) {
  const active = getLocale();

  return (
    <div
      role="group"
      aria-label={m['auth.common.language']()}
      className={cn('inline-flex items-center gap-0.5 rounded-md border border-white/20 bg-white/10 p-0.5 backdrop-blur-sm', className)}
    >
      {locales.map((loc) => {
        const isActive = loc === active;
        return (
          <button
            key={loc}
            type="button"
            aria-pressed={isActive}
            onClick={() => {
              if (!isActive) setLocale(loc);
            }}
            className={cn(
              'rounded px-2.5 py-1 text-xs font-medium transition-colors',
              isActive ? 'bg-white/90 text-foreground shadow-sm' : 'text-white/80 hover:text-white hover:bg-white/10',
            )}
          >
            {LOCALE_LABELS[loc]}
          </button>
        );
      })}
    </div>
  );
}
