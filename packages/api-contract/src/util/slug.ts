/**
 * Anchor-safe slug. Must be deterministic across the API (writes
 * `Page.meta.toc`) and the web client (stamps heading `id`s) so anchor
 * links resolve.
 */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Slug-with-dedup: repeated slugs get `-1`, `-2`, …; empty → `section`. */
export class Slugger {
  private counts = new Map<string, number>();

  slug(text: string): string {
    const base = slug(text) || 'section';
    const count = this.counts.get(base) ?? 0;
    this.counts.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  }

  reset(): void {
    this.counts.clear();
  }
}
