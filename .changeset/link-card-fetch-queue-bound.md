---
'@crowi/plugin-api': minor
'@crowi/api': patch
---

Bound the link-card OGP-fetch semaphore's wait queue to close a DoS where a page embedding `@[card]` links to many unique, slow/unresponsive hosts could pile up an unbounded number of unresolved fetches (crowi-review CROWI-REVIEW-002, high severity).

The shared fetch semaphore (`FETCH_CONCURRENCY_LIMIT = 5`, unchanged) now caps its wait queue at a fixed length and gives queued requests a wait deadline distinct from the post-acquisition fetch timeout. A request that arrives once the queue is already full is rejected synchronously with a new `busy` outcome, never queuing another unresolved Promise; a request that was accepted into the queue but times out before a slot opens up is rejected the same way once its deadline elapses. `@crowi/plugin-api`'s `RenderError.code` union gains `'busy'`, mapped to the same unified link-card fallback card every other OGP-fetch failure uses (no new UI variant) and cached with a short transient TTL so a subsequent render retries once the queue drains.
