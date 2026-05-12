'use client';

import type { SearchPageType } from '@crowi/api-contract';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { m } from '@paraglide/messages.js';

/**
 * "All" is encoded as the empty string so that radix Tabs (which expects a
 * string `value`) can model the `type === undefined` URL state without a
 * separate sentinel. The page component maps `''` ↔ `undefined` at the
 * boundary.
 *
 * `SEARCH_TAB_VALUES` is the single source of truth for valid tab values.
 * The page component uses it to build a type-safe parser, so adding a new
 * tab is a one-line change here.
 */
export const SEARCH_TAB_VALUES = ['', 'portal', 'public', 'user'] as const;
export type SearchTypeTabValue = (typeof SEARCH_TAB_VALUES)[number];
// Keep the literal type (`''`) so callers like `urlType === ALL_TAB` get
// a proper exclude-narrowing on the tagged union.
export const ALL_TAB = '' as const;

/** Type guard used by callers to narrow `string | null` URL params. */
export function isSearchTypeTabValue(value: string | null | undefined): value is SearchTypeTabValue {
  return value !== null && value !== undefined && (SEARCH_TAB_VALUES as readonly string[]).includes(value);
}

// Compile-time assertion: every non-empty tab value is also a valid
// `SearchPageType` (= the contract enum). Adding a tab without updating
// the contract — or vice versa — fails type-check here.
type _NonAllTabValue = Exclude<SearchTypeTabValue, typeof ALL_TAB>;
type _ContractCheck = _NonAllTabValue extends SearchPageType ? true : false;
const _contractCheck: _ContractCheck = true;
void _contractCheck;

interface SearchTypeTabsProps {
  value: SearchTypeTabValue;
  onChange: (value: SearchTypeTabValue) => void;
}

const TAB_LABELS: Record<SearchTypeTabValue, () => string> = {
  '': m['search.type.all'],
  portal: m['search.type.portal'],
  public: m['search.type.public'],
  user: m['search.type.user'],
};

export function SearchTypeTabs({ value, onChange }: SearchTypeTabsProps) {
  return (
    <Tabs
      value={value}
      onValueChange={(v) => {
        if (isSearchTypeTabValue(v)) onChange(v);
      }}
    >
      <TabsList>
        {SEARCH_TAB_VALUES.map((tab) => (
          <TabsTrigger key={tab || 'all'} value={tab}>
            {TAB_LABELS[tab]()}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
