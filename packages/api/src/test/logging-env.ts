// Runs via the `server` project's `setupFiles`, i.e. before any application
// module is imported — the severity floor in `util/logger.ts` is resolved
// lazily on first use, so this must land before that first use rather than
// in `setup.ts`'s `setupFilesAfterEnv`, which imports Crowi (and therefore
// the logger) before its own body runs.
process.env.LOG_LEVEL = 'error';
