'use client';

import { createContext, useContext, useMemo, useState } from 'react';

/**
 * Shares the global search input's focus/expanded state across the (auth)
 * header. When the search box is focused it grows into the right cluster
 * (`flex-1 max-w-2xl`), so siblings that would otherwise eat that width —
 * e.g. the confidentiality notice — yield by reading this and hiding
 * themselves. Defaults to a no-op so consumers work outside a provider.
 */
interface SearchFocusValue {
  isSearchFocused: boolean;
  setSearchFocused: (focused: boolean) => void;
}

const SearchFocusContext = createContext<SearchFocusValue>({
  isSearchFocused: false,
  setSearchFocused: () => {},
});

export function SearchFocusProvider({ children }: { children: React.ReactNode }) {
  const [isSearchFocused, setSearchFocused] = useState(false);
  const value = useMemo(() => ({ isSearchFocused, setSearchFocused }), [isSearchFocused]);
  return <SearchFocusContext.Provider value={value}>{children}</SearchFocusContext.Provider>;
}

export const useSearchFocus = () => useContext(SearchFocusContext);
