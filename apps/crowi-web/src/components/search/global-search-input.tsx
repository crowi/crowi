'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { m } from '@paraglide/messages.js';

/**
 * Global search box embedded in the (auth) header.
 *
 * - Submitting (Enter / form submit) navigates to `/search?q=<encoded>`.
 * - An empty submit is a no-op (we don't want to wipe the user's query
 *   when they accidentally hit Enter on a blank box).
 * - The input value is kept in sync with the URL `?q=` parameter on every
 *   navigation. While on `/search` this means the header box mirrors the
 *   in-page search input (the in-page input is the source of truth — the
 *   header acts as a read-out + jump-back). Off `/search` the URL has no
 *   `?q` so the box reads as empty, which is the desired behaviour.
 *
 * Cmd-K / "/" focus shortcut and the autocomplete dropdown are intentionally
 * deferred to a follow-up (see task openQuestions).
 */
export function GlobalSearchInput() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlQ = searchParams.get('q') ?? '';
  const [value, setValue] = useState(urlQ);

  // Subsequent navigations should refresh the input — `useState(urlQ)` only
  // captures the initial value. Without this effect, navigating to a new
  // `/search?q=...` URL (or away from it) leaves stale text in the box.
  useEffect(() => {
    setValue(urlQ);
  }, [urlQ]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    router.push(`/search?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <form role="search" onSubmit={handleSubmit} className="relative hidden md:block">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={m['search.global.placeholder']()}
        aria-label={m['search.global.placeholder']()}
        className="h-9 w-56 pl-8"
      />
    </form>
  );
}
