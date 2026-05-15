import { describe, it, expect } from 'vitest';
import { AutocompleteCache } from './autocomplete-cache';

/**
 * RFC-0004 Phase 5 — unit tests for the autocomplete LRU cache.
 *
 * Covers hit / miss, TTL expiry, LRU eviction at capacity, key
 * separation by kind, and explicit invalidation (the "Refresh
 * results" path).
 */
describe('AutocompleteCache', () => {
  it('returns a stored value on a hit', () => {
    const cache = new AutocompleteCache<string[]>(50, 30_000);
    cache.set('user', 'al', ['alice']);
    expect(cache.get('user', 'al')).toEqual(['alice']);
  });

  it('returns undefined on a miss', () => {
    const cache = new AutocompleteCache<string[]>(50, 30_000);
    expect(cache.get('user', 'zz')).toBeUndefined();
  });

  it('is case-insensitive on the query', () => {
    const cache = new AutocompleteCache<string[]>(50, 30_000);
    cache.set('user', 'AL', ['alice']);
    expect(cache.get('user', 'al')).toEqual(['alice']);
  });

  it('separates entries by kind', () => {
    const cache = new AutocompleteCache<string[]>(50, 30_000);
    cache.set('user', 'a', ['alice']);
    cache.set('page', 'a', ['/api']);
    expect(cache.get('user', 'a')).toEqual(['alice']);
    expect(cache.get('page', 'a')).toEqual(['/api']);
  });

  it('expires entries past the TTL', () => {
    let clock = 1_000;
    const cache = new AutocompleteCache<string[]>(50, 30_000, () => clock);
    cache.set('user', 'al', ['alice']);

    clock += 29_000;
    expect(cache.get('user', 'al')).toEqual(['alice']);

    clock += 2_000; // now 31s past store — expired
    expect(cache.get('user', 'al')).toBeUndefined();
  });

  it('evicts the least-recently-used entry at capacity', () => {
    const cache = new AutocompleteCache<string[]>(2, 30_000);
    cache.set('user', 'a', ['a']);
    cache.set('user', 'b', ['b']);
    // Touch 'a' so 'b' becomes the LRU.
    cache.get('user', 'a');
    cache.set('user', 'c', ['c']);

    expect(cache.get('user', 'a')).toEqual(['a']);
    expect(cache.get('user', 'b')).toBeUndefined(); // evicted
    expect(cache.get('user', 'c')).toEqual(['c']);
    expect(cache.size).toBe(2);
  });

  it('invalidates a single entry', () => {
    const cache = new AutocompleteCache<string[]>(50, 30_000);
    cache.set('user', 'al', ['alice']);
    cache.invalidate('user', 'al');
    expect(cache.get('user', 'al')).toBeUndefined();
  });

  it('clears every entry', () => {
    const cache = new AutocompleteCache<string[]>(50, 30_000);
    cache.set('user', 'a', ['a']);
    cache.set('page', 'b', ['b']);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
