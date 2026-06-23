import * as Y from 'yjs';
import { Types } from 'mongoose';
import type { CollabModels } from '../models';
import { createCompactor } from '../compaction';
import { createDocBaseRevisionStore, type DocBaseRevisionStore } from '../doc-base-revision';
import { createOnChange } from '../hooks/on-change';
import { createOnLoadDocument } from '../hooks/on-load-document';
import { createOnStoreDocument } from '../hooks/on-store-document';
import { createInvalidatedPagesStore, createPageInvalidator, type InvalidatedPagesStore, type PageInvalidator } from '../invalidation';
import type { CollabContext } from '../types';
import { CONTENT_FIELD } from '../yjs-doc';
import { payloadToUint8Array } from '../yjs-payload';
import { encodeYjsDelta, makeFixtures, type CollabFixtures } from './fixtures';
import { registerTestModels, startInMemoryMongo, type SmokeMongo } from './setup';

/**
 * G1 regression tests that exercise the Hocuspocus document lifecycle shape.
 *
 * Jest cannot import `@hocuspocus/server` directly in this package because its
 * CJS bundle requires `crossws`'s ESM adapter (the rest of the suite has the
 * same limitation). Instead this harness intentionally models the exact
 * lifecycle edges that matter here while reusing the production Crowi hooks:
 *
 *   - `createDocument` returns an existing live document without calling
 *     `onLoadDocument` (Hocuspocus's existing-doc fast path);
 *   - a last close runs `onStoreDocument` before the document is unloaded;
 *   - a fresh document materialisation goes through the real
 *     `createOnLoadDocument` hook and residual-row replay;
 *   - document edits go through the real `createOnChange` hook.
 *
 * The tests therefore avoid the previous fake `createOnLoadDocument` direct
 * calls that missed these races, while staying deterministic under Jest/CJS.
 */

class HarnessDocument extends Y.Doc {
  readonly name: string;
  readonly broadcasts: string[] = [];
  directConnections = 0;

  constructor(name: string) {
    super();
    this.name = name;
  }

  broadcastStateless(payload: string): void {
    this.broadcasts.push(payload);
  }

  getConnectionsCount(): number {
    return this.directConnections;
  }
}

interface HarnessConnection {
  document: HarnessDocument | null;
  transact(fn: (document: HarnessDocument) => void): Promise<void>;
  disconnect(): Promise<void>;
}

class HocuspocusLifecycleHarness {
  readonly documents = new Map<string, HarnessDocument>();
  readonly invalidator: PageInvalidator;
  readonly docBaseRevisions: DocBaseRevisionStore;
  readonly invalidatedPages: InvalidatedPagesStore;

  private readonly onLoadDocument: ReturnType<typeof createOnLoadDocument>;
  private readonly onChange: ReturnType<typeof createOnChange>;
  private readonly onStoreDocument: ReturnType<typeof createOnStoreDocument>;

  constructor(
    private readonly models: CollabModels,
    opts: { schedule?: (fn: () => void, ms: number) => void } = {},
  ) {
    this.docBaseRevisions = createDocBaseRevisionStore();
    this.invalidatedPages = createInvalidatedPagesStore();
    const compactor = createCompactor({ models: { Page: models.Page, PageYjsUpdate: models.PageYjsUpdate, Revision: models.Revision } });
    this.onLoadDocument = createOnLoadDocument({
      models: { Page: models.Page, Revision: models.Revision, PageYjsUpdate: models.PageYjsUpdate },
      docBaseRevisions: this.docBaseRevisions,
      invalidatedPages: this.invalidatedPages,
    });
    this.onChange = createOnChange({ models: { PageYjsUpdate: models.PageYjsUpdate }, compactor });
    this.onStoreDocument = createOnStoreDocument({ models: { Page: models.Page }, compactor });
    this.invalidator = createPageInvalidator({
      instance: this,
      docBaseRevisions: this.docBaseRevisions,
      invalidatedPages: this.invalidatedPages,
      graceMs: 50,
      schedule: opts.schedule,
    });
  }

  async openDirectConnection(pageId: string, context: CollabContext): Promise<HarnessConnection> {
    const document = await this.createDocument(pageId, context);
    document.directConnections += 1;

    return {
      document,
      transact: async (fn) => {
        const updates: Uint8Array[] = [];
        const capture = (update: Uint8Array) => updates.push(update);
        document.on('update', capture);
        try {
          document.transact(() => fn(document), { source: 'local', context });
        } finally {
          document.off('update', capture);
        }
        for (const update of updates) {
          await this.onChange({
            documentName: pageId,
            document,
            update,
            context,
            instance: this,
            clientsCount: document.getConnectionsCount(),
            requestHeaders: new Headers(),
            requestParameters: new URLSearchParams(),
            socketId: 'direct-test',
            transactionOrigin: { source: 'local', context },
            connection: undefined,
          } as never);
        }
      },
      disconnect: async () => {
        if (this.documents.get(pageId) !== document) {
          return;
        }
        document.directConnections = Math.max(0, document.directConnections - 1);
        if (document.directConnections === 0) {
          await this.storeAndUnload(pageId, document, context);
        }
      },
    };
  }

  closeConnections(documentName?: string): void {
    for (const [pageId, document] of [...this.documents]) {
      if (documentName && pageId !== documentName) continue;
      document.directConnections = 0;
      void this.storeAndUnload(pageId, document, { userId: 'force-close', pageId, readonly: false });
    }
  }

  private async createDocument(pageId: string, context: CollabContext): Promise<HarnessDocument> {
    const existing = this.documents.get(pageId);
    if (existing) {
      return existing;
    }

    const document = new HarnessDocument(pageId);
    await this.onLoadDocument({
      documentName: pageId,
      document,
      instance: this,
      context,
      connectionConfig: { isAuthenticated: true, readOnly: false },
      socketId: 'direct-test',
      requestHeaders: new Headers(),
      requestParameters: new URLSearchParams(),
    } as never);
    this.documents.set(pageId, document);
    return document;
  }

  private async storeAndUnload(pageId: string, document: HarnessDocument, context: CollabContext): Promise<void> {
    await this.onStoreDocument({
      documentName: pageId,
      document,
      instance: this,
      clientsCount: 0,
      lastContext: context,
      lastTransactionOrigin: { source: 'local', context },
    } as never);
    if (document.directConnections === 0 && this.documents.get(pageId) === document) {
      this.documents.delete(pageId);
      document.destroy();
    }
  }
}

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
};

describe('external-edit invalidation real lifecycle edges (G1)', () => {
  let memMongo: SmokeMongo | undefined;
  let models: CollabModels;
  let fixtures: CollabFixtures;
  let warnSpy: jest.SpyInstance | undefined;

  beforeAll(async () => {
    memMongo = await startInMemoryMongo();
    const reg = registerTestModels();
    models = reg.models;
    fixtures = makeFixtures(models);
  });

  afterAll(async () => {
    await memMongo?.stop();
  });

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy?.mockRestore();
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Page = () => models.Page as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Revision = () => models.Revision as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const PageYjsUpdate = () => models.PageYjsUpdate as any;

  const contextFor = (pageId: string): CollabContext => ({
    userId: new Types.ObjectId().toString(),
    pageId,
    readonly: false,
  });

  const seedPageWithRevision = async (body: string): Promise<{ pageId: string; revisionId: string }> => {
    const { pageId } = await fixtures.seedPage();
    const revisionId = await fixtures.seedRevision(pageId, body);
    await Page()
      .updateOne({ _id: pageId }, { $set: { currentRevision: revisionId } })
      .exec();
    return { pageId, revisionId };
  };

  const externalEdit = async (pageId: string, body: string): Promise<string> => {
    const page = await Page().findById(pageId).exec();
    if (!page) throw new Error(`externalEdit: page ${pageId} not found`);
    const rev = await Revision().create({ path: page.path, body, author: page.creator, format: 'markdown' });
    await Page()
      .updateOne(
        { _id: pageId },
        {
          $set: {
            revision: rev._id,
            currentRevision: rev._id,
            yjsState: null,
            yjsCheckpointAt: null,
          },
        },
      )
      .exec();
    return rev._id.toString();
  };

  const decodeYjsState = (state: Buffer | null | undefined): string | null => {
    if (!state || state.length === 0) return null;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, payloadToUint8Array(state));
    return doc.getText(CONTENT_FIELD).toString();
  };

  test('drain-window reconnect cannot attach to the stale existing Document and eventually rematerialises from the external revision body', async () => {
    const heldDrains: Array<() => void> = [];
    const harness = new HocuspocusLifecycleHarness(models, { schedule: (fn) => heldDrains.push(fn) });
    const { pageId } = await seedPageWithRevision('initial body');

    const staleConn = await harness.openDirectConnection(pageId, contextFor(pageId));
    await staleConn.transact((doc) => {
      const text = doc.getText(CONTENT_FIELD);
      text.delete(0, text.length);
      text.insert(0, 'STALE LIVE DOC BODY');
    });
    expect(staleConn.document?.getText(CONTENT_FIELD).toString()).toBe('STALE LIVE DOC BODY');

    await externalEdit(pageId, 'EXTERNAL BODY WINS');
    await harness.invalidator.invalidatePages([pageId], 'page-body-replaced');

    // Reconnect while the stale document is still present in the registry.
    // Correct behaviour is to reject/hold this connection until the drain
    // finishes; it must never receive the stale existing Y.Doc.
    const reconnectDuringDrain = await harness.openDirectConnection(pageId, contextFor(pageId));
    expect(reconnectDuringDrain.document?.getText(CONTENT_FIELD).toString()).toBe('EXTERNAL BODY WINS');

    await reconnectDuringDrain.disconnect();
    await staleConn.disconnect();
    heldDrains.forEach((fn) => fn());
    await waitFor(() => !harness.documents.has(pageId));

    const afterDrain = await harness.openDirectConnection(pageId, contextFor(pageId));
    expect(afterDrain.document?.getText(CONTENT_FIELD).toString()).toBe('EXTERNAL BODY WINS');
    await afterDrain.disconnect();
  });

  test('last-close store during invalidation does not persist the stale live document back into Page.yjsState', async () => {
    const drains: Array<() => void> = [];
    const harness = new HocuspocusLifecycleHarness(models, { schedule: (fn) => drains.push(fn) });
    const { pageId } = await seedPageWithRevision('initial body');

    const conn = await harness.openDirectConnection(pageId, contextFor(pageId));
    await conn.transact((doc) => {
      const text = doc.getText(CONTENT_FIELD);
      text.delete(0, text.length);
      text.insert(0, 'STALE DOC THAT MUST NOT BE CHECKPOINTED');
    });

    await externalEdit(pageId, 'EXTERNAL BODY AFTER HTTP SAVE');
    expect((await Page().findById(pageId).lean().exec()).yjsState ?? null).toBeNull();

    await harness.invalidator.invalidatePages([pageId], 'page-body-replaced');
    drains.forEach((fn) => fn());
    await waitFor(() => !harness.documents.has(pageId));

    const page = await Page().findById(pageId).lean().exec();
    expect(decodeYjsState(page.yjsState as Buffer | null | undefined)).not.toBe('STALE DOC THAT MUST NOT BE CHECKPOINTED');
    expect(page.yjsState ?? null).toBeNull();

    const reconnect = await harness.openDirectConnection(pageId, contextFor(pageId));
    expect(reconnect.document?.getText(CONTENT_FIELD).toString()).toBe('EXTERNAL BODY AFTER HTTP SAVE');
    await reconnect.disconnect();
  });

  test('residual PageYjsUpdate rows from the old lineage are not replayed onto the external edit body', async () => {
    const harness = new HocuspocusLifecycleHarness(models);
    const { pageId } = await seedPageWithRevision('initial body');

    // Simulate a pre-external-edit collab delta that made it to the append
    // log but was not checkpointed. A fresh materialisation must not replay
    // this old-lineage row on top of the external edit body.
    await PageYjsUpdate().create({
      pageId,
      payload: encodeYjsDelta('OLD LINEAGE ROW'),
      createdAt: new Date(),
    });
    expect(await fixtures.countPending(pageId)).toBe(1);

    await externalEdit(pageId, 'EXTERNAL BODY ONLY');

    const conn = await harness.openDirectConnection(pageId, contextFor(pageId));
    expect(conn.document?.getText(CONTENT_FIELD).toString()).toBe('EXTERNAL BODY ONLY');
    await conn.disconnect();
  });
});
