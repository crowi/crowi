/**
 * RFC-0021 §6.3/DC-6 (Phase 2c-1) — AC-18's SECOND hop: `createCollabServer`
 * (`server.ts`) must forward the `draftPublisher` option it receives
 * straight through to `createSaveFlow`. The FIRST hop (`attachCollabServer`
 * -> `createCollabServer`) is covered in
 * `packages/api/src/collab/attach.test.ts`.
 *
 * `server.ts` itself can't normally be imported under Jest — its value
 * import of `Hocuspocus` from `@hocuspocus/server` pulls in the transitive
 * `crossws` ESM-only bundle (see `presence-wiring.test.ts`'s doc comment for
 * the same documented constraint). Every OTHER file `server.ts` imports only
 * ever imports `@hocuspocus/server` as `import type` (erased at compile
 * time), so mocking `@hocuspocus/server` with a factory here removes the
 * ONLY value import that would otherwise pull in `crossws`, and `server.ts`
 * becomes importable. `./save-flow`'s `createSaveFlow` is mocked too so we
 * can capture the options it was called with, without spinning up a real
 * save flow (which needs live Mongoose models).
 */

jest.mock('@hocuspocus/server', () => ({
  Hocuspocus: jest.fn().mockImplementation(function stubHocuspocus(this: Record<string, unknown>, opts: Record<string, unknown>) {
    Object.assign(this, opts);
  }),
}));

let lastCreateSaveFlowOpts: CreateSaveFlowOptions | null = null;
jest.mock('../save-flow', () => ({
  createSaveFlow: jest.fn((opts: unknown) => {
    lastCreateSaveFlowOpts = opts as CreateSaveFlowOptions;
    return { executeSave: jest.fn() };
  }),
}));

import type { CollabDraftPublisher, CollabModels } from '../models';
import type { CreateSaveFlowOptions } from '../save-flow';
import { createCollabServer } from '../server';
import type { CollabWsTokenUtil } from '../types';

const stubModels = { Page: {}, Revision: {}, PageYjsUpdate: {}, User: {}, PluginRenderCache: {} } as unknown as CollabModels;
const stubWsTokenUtil: CollabWsTokenUtil = { verifyWsToken: () => null };

describe('createCollabServer -> createSaveFlow draftPublisher wiring (RFC-0021 §6.3/DC-6, AC-18)', () => {
  beforeEach(() => {
    lastCreateSaveFlowOpts = null;
    jest.clearAllMocks();
  });

  it('forwards the injected draftPublisher verbatim to createSaveFlow', () => {
    const draftPublisher: CollabDraftPublisher = jest.fn();

    createCollabServer({ models: stubModels, wsTokenUtil: stubWsTokenUtil, draftPublisher });

    expect(lastCreateSaveFlowOpts).not.toBeNull();
    expect(lastCreateSaveFlowOpts?.draftPublisher).toBe(draftPublisher);
  });

  it('when omitted, createSaveFlow receives no draftPublisher (fallback to the inline updateOne is preserved)', () => {
    createCollabServer({ models: stubModels, wsTokenUtil: stubWsTokenUtil });

    expect(lastCreateSaveFlowOpts).not.toBeNull();
    expect(lastCreateSaveFlowOpts?.draftPublisher).toBeUndefined();
  });

  it('does not build createSaveFlow at all when a pre-built saveFlow is injected (draftPublisher wiring is skipped, matching contentSequenceAllocator)', () => {
    const draftPublisher: CollabDraftPublisher = jest.fn();
    const injectedSaveFlow = { executeSave: jest.fn() };

    createCollabServer({ models: stubModels, wsTokenUtil: stubWsTokenUtil, draftPublisher, saveFlow: injectedSaveFlow });

    expect(lastCreateSaveFlowOpts).toBeNull();
  });
});
