---
"@crowi/api": minor
---

The api now emits structured NDJSON log records with per-request correlation (`LOG_LEVEL` selects the severity floor, default `info`), and every fatal process event (a startup failure, an uncaught exception, or an unhandled promise rejection) is now captured by an installed handler and reported as one such record before the process exits — previously, an unhandled rejection under Node's `warn`, `warn-with-error-code`, or `none` unhandled-rejection modes left the process running instead of exiting, and it now exits with status 1 the same way the `default`/`throw` modes always did, which means any collaborative-editing checkpoint still inside its debounce window at that moment is no longer flushed by graceful shutdown and is lost.
