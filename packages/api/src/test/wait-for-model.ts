/**
 * Shared test helper for fire-and-forget side effects.
 *
 * Several listeners run as best-effort `Promise.resolve().then(...)` work
 * (e.g. the page-event auto-watch in `events/page.ts`, backlink
 * registration), so the row they write may not exist yet when the
 * triggering HTTP response returns. Poll the event loop until the document
 * matching `filter` appears instead of guessing a fixed delay.
 *
 * Returns the document once found, or `null` after `maxTicks` exhausted.
 */
import type { FilterQuery, Model } from 'mongoose';

export async function waitForModel<T>(model: Model<T>, filter: FilterQuery<T>, maxTicks = 50): Promise<T | null> {
  for (let i = 0; i < maxTicks; i++) {
    const found = await model.findOne(filter);
    if (found) return found;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return null;
}
