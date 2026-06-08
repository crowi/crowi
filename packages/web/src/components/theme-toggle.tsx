'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useSyncExternalStore } from 'react';
import { m } from '@paraglide/messages.js';
import { DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

type ThemeOption = 'system' | 'light' | 'dark';

const OPTIONS: { value: ThemeOption; label: () => string; Icon: typeof Monitor }[] = [
  { value: 'system', label: () => m['theme.system'](), Icon: Monitor },
  { value: 'light', label: () => m['theme.light'](), Icon: Sun },
  { value: 'dark', label: () => m['theme.dark'](), Icon: Moon },
];

// `next-themes` resolves the active theme only on the client, so the toggles
// must not commit a selection on the server render (it would mismatch the
// client). `useSyncExternalStore` returns `false` on the server snapshot and
// `true` after hydration without tripping React 19's `set-state-in-effect`
// rule (the codebase's chosen pattern over useState + useEffect).
const noopSubscribe = () => () => {};
const useMounted = () =>
  useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );

/**
 * Segmented theme switcher for pre-auth screens (login / register / …),
 * styled to sit beside `LocaleSwitcher` on the dark login backdrop.
 *
 * `next-themes` resolves the active theme only on the client, so the control
 * renders a neutral (no-selection) state until `mounted` flips after
 * hydration — this avoids a server/client `aria-pressed` mismatch.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();

  return (
    <div
      role="group"
      aria-label={m['theme.label']()}
      className={cn('inline-flex items-center gap-0.5 rounded-md border border-white/20 bg-white/10 p-0.5 backdrop-blur-sm', className)}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const isActive = mounted && theme === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={isActive}
            title={label()}
            onClick={() => {
              if (!isActive) setTheme(value);
            }}
            className={cn(
              'rounded px-2 py-1 transition-colors',
              isActive ? 'bg-white/90 text-foreground shadow-sm' : 'text-white/80 hover:text-white hover:bg-white/10',
            )}
          >
            <Icon className="h-4 w-4" />
            <span className="sr-only">{label()}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Theme switcher rendered as a labelled radio group inside the header user
 * dropdown. Uses the same `useTheme()` source as the segmented control so the
 * two stay in sync. Until hydration completes the radio group has no selection
 * (server has no resolved theme), preventing a hydration mismatch.
 */
export function ThemeToggleMenuGroup() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();

  return (
    <>
      <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">{m['theme.label']()}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={mounted ? theme : undefined} onValueChange={(value) => setTheme(value)}>
        {OPTIONS.map(({ value, label, Icon }) => (
          // preventDefault on select keeps the dropdown open while switching so
          // the user can see the change apply and pick another option.
          <DropdownMenuRadioItem key={value} value={value} onSelect={(e) => e.preventDefault()}>
            <Icon className="h-4 w-4 mr-2" />
            {label()}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}
