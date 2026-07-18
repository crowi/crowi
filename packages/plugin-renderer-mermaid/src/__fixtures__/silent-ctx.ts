import type { RenderContext } from '@crowi/plugin-api';

/** Shared no-op `RenderContext` for tests that don't care about logging. */
export const silentCtx: RenderContext = {
  mode: 'save',
  log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  actor: { kind: 'system' },
};
