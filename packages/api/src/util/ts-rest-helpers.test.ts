import { Types } from 'mongoose';
import { actorFromUser } from './ts-rest-helpers';

/**
 * feature-plugin-renderer-mermaid spec §6 — every authenticated renderer
 * call site (`Revision.prepareRevision`, `page.ts`/`revision.ts`'s
 * `computeRevisionRenderArtifactsAsync` calls, `page-preview.ts`'s
 * `run()` call) builds its `RenderActor` through this single shared
 * helper. Covered directly here (pure function, no DB/HTTP needed) so
 * the 5 call sites don't each need their own shape-correctness test —
 * see the handler/model test files for the "is this helper actually
 * wired in at the call site" half (`page.test.ts`, `revision.test.ts`,
 * `page-preview.test.ts`, `models/revision.test.ts`).
 */
describe('actorFromUser', () => {
  it('maps a user whose _id is a Mongoose ObjectId to a RenderActor', () => {
    const id = new Types.ObjectId();
    expect(actorFromUser({ _id: id })).toEqual({ kind: 'user', userId: id.toString() });
  });

  it('maps a user whose _id is already a string to a RenderActor', () => {
    const id = new Types.ObjectId().toString();
    expect(actorFromUser({ _id: id })).toEqual({ kind: 'user', userId: id });
  });

  it('never returns the "anonymous" or "system" variant — every real call site is authenticated', () => {
    const actor = actorFromUser({ _id: new Types.ObjectId() });
    expect(actor.kind).toBe('user');
  });
});
