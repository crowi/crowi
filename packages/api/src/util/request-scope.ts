import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Dedicated ALS instance for module-logger request correlation. Kept
 * separate from `service/config.ts`'s write-queue ALS — the two track
 * unrelated async chains and must not share continuations.
 */
const requestScopeStorage = new AsyncLocalStorage<RequestScope>();

export interface RequestScope {
  readonly requestId: string;
}

/**
 * Thin `AsyncLocalStorage.run()` wrapper. `run()`, never `enterWith()`, so a
 * scope never leaks past the callback's own continuation into unrelated
 * later work sharing the same execution context.
 */
export const runWithRequestScope = <T>(scope: RequestScope, callback: () => T): T => requestScopeStorage.run(scope, callback);

export const getRequestScope = (): RequestScope | undefined => requestScopeStorage.getStore();
