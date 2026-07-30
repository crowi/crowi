import { CURRENT_AST_VERSION, unwrapRenderedAst } from '@crowi/api-contract';
import { Hono } from 'hono';
import { createAstNegotiation } from 'src/hono/middleware/ast-negotiation';
import { pickRenderedAstShape } from './rendered-ast-negotiation';

/**
 * RFC-0023 §9 — the content-negotiation chokepoint + mixed-version
 * matrix (design doc §9 test row 3: `pickRenderedAstShape` called
 * directly to simulate every requestedVersion × server-capability
 * combination in one jest suite).
 */

const bareRoot = {
  type: 'root',
  children: [
    { type: 'paragraph', children: [{ type: 'text', value: 'hello' }] },
    // A third-party node no closed registry knows about — the legacy
    // branch must pass it through completely unvalidated.
    { type: 'x-thirdparty-callout', anything: { deep: [1, 2, 3] } },
  ],
};

describe('pickRenderedAstShape — negotiation matrix', () => {
  it('absent AST stays absent regardless of the declared version (unchanged from today)', () => {
    expect(pickRenderedAstShape(undefined, undefined)).toBeUndefined();
    expect(pickRenderedAstShape(CURRENT_AST_VERSION, undefined)).toBeUndefined();
  });

  it('no declaration → the stored bare Root, SAME reference, no validation, no transformation', () => {
    const out = pickRenderedAstShape(undefined, bareRoot);
    expect(out).toBe(bareRoot); // identity — nothing was cloned or sanitised
  });

  it('an unsupported declared version behaves exactly like no declaration (old-client vs new-server skew)', () => {
    expect(pickRenderedAstShape(999, bareRoot)).toBe(bareRoot);
    expect(pickRenderedAstShape(0, bareRoot)).toBe(bareRoot);
  });

  it('v1 declaration → the sanitised envelope (unknown third-party node becomes crowiOpaque)', () => {
    const out = pickRenderedAstShape(CURRENT_AST_VERSION, bareRoot) as { astVersion: number; root: { children: Array<{ type: string; reason?: string }> } };
    expect(out.astVersion).toBe(CURRENT_AST_VERSION);
    expect(out.root.children[0].type).toBe('paragraph');
    expect(out.root.children[1]).toMatchObject({ type: 'crowiOpaque', reason: 'unknown-type' });
  });

  it('v1 declaration with a broken stored value → the envelope-invalid placeholder envelope (never absent, never a throw)', () => {
    const out = pickRenderedAstShape(CURRENT_AST_VERSION, 'utterly broken') as { astVersion: number; root: { children: Array<{ kind?: string }> } };
    expect(out.astVersion).toBe(CURRENT_AST_VERSION);
    expect(out.root.children[0].kind).toBe('envelope-invalid');
  });

  it('mixed-replica client-side detection: unwrapRenderedAst resolves both shapes (old replica ignored the header → bare Root; new replica → envelope)', () => {
    // Old replica: header sent, bare Root returned anyway — the shape
    // detection (astVersion presence), not the request, is what the
    // client trusts.
    const fromOldReplica = pickRenderedAstShape(undefined, bareRoot);
    expect(unwrapRenderedAst(fromOldReplica)).toBe(bareRoot);
    // New replica: envelope returned — unwrap yields its root.
    const fromNewReplica = pickRenderedAstShape(CURRENT_AST_VERSION, bareRoot) as { root: unknown };
    expect(unwrapRenderedAst(fromNewReplica)).toBe(fromNewReplica.root);
    // Junk yields undefined (defensive normaliser).
    expect(unwrapRenderedAst({ neither: 'shape' })).toBeUndefined();
    expect(unwrapRenderedAst(undefined)).toBeUndefined();
  });
});

describe('createAstNegotiation middleware', () => {
  const buildApp = () => {
    const app = new Hono();
    app.use('*', createAstNegotiation());
    app.get('/probe', (c) => c.json({ astVersion: c.get('astVersion' as never) ?? null }));
    return app;
  };

  it('absent header → variable unset', async () => {
    const res = await buildApp().request('/probe');
    expect(await res.json()).toEqual({ astVersion: null });
  });

  it('X-Crowi-Ast-Version: 1 → astVersion 1', async () => {
    const res = await buildApp().request('/probe', { headers: { 'X-Crowi-Ast-Version': '1' } });
    expect(await res.json()).toEqual({ astVersion: 1 });
  });

  it('non-integer / garbage values leave the variable unset (treated as legacy)', async () => {
    for (const value of ['abc', '1.5', '-1', '1,2', '']) {
      const res = await buildApp().request('/probe', { headers: { 'X-Crowi-Ast-Version': value } });
      expect(await res.json()).toEqual({ astVersion: null });
    }
  });

  it('a different integer flows through (the equality check lives in pickRenderedAstShape, not here)', async () => {
    const res = await buildApp().request('/probe', { headers: { 'X-Crowi-Ast-Version': '2' } });
    expect(await res.json()).toEqual({ astVersion: 2 });
  });
});
