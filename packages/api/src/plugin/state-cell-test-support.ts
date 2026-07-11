import type { PluginContext, StateCell } from '@crowi/plugin-api';
import { createStateCell } from './plugin-state-cell';

/**
 * Test-only helper shared by `mail-smtp.test.ts` and
 * `storage-aws-s3.test.ts`: mirrors `PluginManager.getOrCreateStateCell()`
 * — one cell per "plugin activation session" (i.e. per test, once `reset()`
 * is called from `beforeEach`), shared across every `makeCtx()`-built
 * `PluginContext` in that test — exactly like the real activation-time
 * `ctx` and a later `reconfigure(ctx)` share one cell via the plugin name
 * (AC-2).
 *
 * `plugin-search-elasticsearch/src/__tests__/driver.test.ts` needs its own
 * copy of the underlying cell algorithm instead of importing this: that
 * package only depends on `@crowi/plugin-api` (the type-only contract),
 * not `@crowi/api`, so it can't reach `createStateCell` here.
 */
export function makeSharedPluginState(): { state: PluginContext['state']; reset: () => void } {
  let sharedCell: StateCell<unknown> | undefined;
  return {
    state: (<T>(initial: T): StateCell<T> => {
      if (!sharedCell) sharedCell = createStateCell(initial) as StateCell<unknown>;
      return sharedCell as StateCell<T>;
    }) as PluginContext['state'],
    reset: () => {
      sharedCell = undefined;
    },
  };
}
