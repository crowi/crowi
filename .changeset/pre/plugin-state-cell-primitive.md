---
"@crowi/plugin-api": minor
"@crowi/plugin-storage-aws-s3": patch
"@crowi/plugin-mail-smtp": patch
"@crowi/plugin-search-elasticsearch": patch
---

Plugin SDK: add a hot-reload `StateCell<T>` primitive, exposed as `ctx.state<T>(initial)` on `PluginContext`. It gives `reconfigure`-implementing driver plugins (storage / search / mail sending) a structured way to hold a swappable resource (an SDK client, a connection pool) instead of hand-rolling module-scope mutable state: `get()`/`withValue()` read the current value, and `set(next, { dispose })` swaps in a new one — `dispose(prev)` only runs once every `withValue()` call in flight against the previous value has settled, so a resource still in use is never torn down under a caller. For the same plugin, every `PluginContext` instance (the activation-time `ctx` and every later `reconfigure(ctx)`) shares the same cell.

`@crowi/plugin-storage-aws-s3`, `@crowi/plugin-mail-smtp`, and `@crowi/plugin-search-elasticsearch` are migrated onto this primitive. Each now explicitly disposes the resource `reconfigure` replaces — `S3Client.destroy()`, `Transporter.close()`, and the Elasticsearch `Client.close()` respectively — fixing a connection leak on every hot-reload. The Elasticsearch driver's client close is also no longer fire-and-forget the instant `reconfigure` returns: it now waits for any in-flight search/index/remove/rebuild call still using the old client to finish first.
