/**
 * feature-image-derivative-optimization §7a — shared by `storage-local.test.ts`
 * (same-process races) and `storage-local-atomic-put-worker.ts` (the
 * cross-process race worker it spawns): splits `content` into ordered chunks
 * so a slow `Readable` can drip-feed a `put()` across several event-loop
 * turns, widening the window for a concurrent reader to land mid-write.
 */
export function chunkOf(content: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += size) {
    chunks.push(content.slice(i, i + size));
  }
  return chunks;
}
