'use client';

import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { m } from '@paraglide/messages.js';

interface SecretFieldProps {
  /** DOM id used for the <Label htmlFor> association. */
  id: string;
  /** Visible label text rendered above the input. */
  label: string;
  /** Current text in the input. Empty string when the user hasn't typed
   *  yet or the saved secret has just been "Clear" requested. */
  value: string;
  /** True when a secret is currently persisted on the server. Drives the
   *  "Currently saved" badge, the placeholder copy, and whether the
   *  Clear / Undo buttons are rendered. */
  hasValue: boolean;
  /** True when the user has typed a new value since the last save. */
  dirty: boolean;
  /** True when the user pressed "Clear saved secret" — the saved value will
   *  be wiped on the next save. */
  clearRequested: boolean;
  /** Called with the new input value when the user types. */
  onChange: (value: string) => void;
  /** Called when the user clicks "Clear saved secret". */
  onClearRequested: () => void;
  /** Called when the user clicks "Undo clear" while a clear is pending. */
  onUndoClear: () => void;
  /** Optional per-field server-side validation error to render below the input. */
  error?: string;
}

/**
 * Sensitive-value form field shared by /admin/app and /admin/mail.
 *
 * Three-state UX (mirrors the wire-level "omitted / empty / non-empty"
 * semantics on the API side):
 *  1. Saved + idle    — input is empty; placeholder reads "Leave empty to
 *     keep the current value"; "Currently saved" badge shown; "Clear
 *     saved secret" button shown.
 *  2. Dirty           — user typed a value; saving will overwrite the
 *     stored secret. Badges hidden.
 *  3. Clear-pending   — user clicked Clear; input is disabled; an amber
 *     "Will be cleared on save" badge replaces the green one; an "Undo
 *     clear" button replaces "Clear".
 */
export function SecretField({ id, label, value, hasValue, dirty, clearRequested, onChange, onClearRequested, onUndoClear, error }: SecretFieldProps) {
  // `dirty` is reserved for callers that want to drive UI off it; the
  // current visual treatment derives entirely from value/hasValue/
  // clearRequested. Keep the prop in the API for forward-compat with
  // future "unsaved changes" indicators.
  void dirty;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        {hasValue && !clearRequested && (
          <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
            <CheckCircle2 className="h-3 w-3" />
            {m['admin.common.secret_saved_badge']()}
          </span>
        )}
        {clearRequested && (
          <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
            {m['admin.common.secret_clear_pending_badge']()}
          </span>
        )}
      </div>
      <Input
        id={id}
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={Boolean(error)}
        placeholder={hasValue ? m['admin.common.field_secret_placeholder_set']() : m['admin.common.field_secret_placeholder_unset']()}
        autoComplete="new-password"
        disabled={clearRequested}
      />
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {hasValue && (
        <div className="pt-1">
          {!clearRequested ? (
            <Button type="button" size="sm" variant="outline" onClick={onClearRequested}>
              {m['admin.common.secret_clear_button']()}
            </Button>
          ) : (
            <Button type="button" size="sm" variant="ghost" onClick={onUndoClear}>
              {m['admin.common.secret_clear_undo']()}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
