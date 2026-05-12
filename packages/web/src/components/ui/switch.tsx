'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  name?: string;
  /** Accessible label fallback when no <Label htmlFor> is associated. */
  'aria-label'?: string;
  className?: string;
}

/**
 * Minimal shadcn-style toggle switch. We don't pull in
 * @radix-ui/react-switch — the surface is small enough that a plain
 * button[role="switch"] with the standard Tailwind tokens
 * (bg-primary / bg-input / etc.) keeps the dependency footprint tight and
 * matches the visual language of the existing UI primitives.
 *
 * For form-style usage, pair with `<Label htmlFor>` to get the same
 * keyboard / click-on-label affordance as the native checkbox.
 */
export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onCheckedChange, disabled, id, name, className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      data-state={checked ? 'checked' : 'unchecked'}
      data-slot="switch"
      id={id}
      name={name}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-input',
        className,
      )}
      aria-label={props['aria-label']}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  );
});
