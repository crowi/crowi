import { AST_INPUT_LIMIT_BYTES, SIDECAR_KEYS } from '@crowi/api-contract';
import { applyRevisionAstBudget, REVISION_BSON_BUDGET_BYTES, REVISION_FIXED_HEADROOM_BYTES } from './revision-size-guard';

/**
 * RFC-0023 §10 — save-time revision size guard. The invariant under
 * test: the guard measures the WHOLE document (body + meta + yjsUpdate
 * + AST + fixed headroom), and stripping sidecars largest-first
 * restores today's byte-identical shape — no page that saves today can
 * become unsavable because of sidecars.
 */

const htmlWithSidecar = (value: string, sidecarKey: string, payload: unknown) => ({
  type: 'html',
  value,
  data: { [sidecarKey]: payload },
});

const plainHtml = (value: string) => ({ type: 'html', value });

const noopWarn = () => undefined;

describe('applyRevisionAstBudget', () => {
  it('leaves an in-budget document untouched (sidecars intact, zero strips)', () => {
    const ast = { type: 'root', children: [htmlWithSidecar('<pre>x</pre>', 'crowiCode', { lang: 'ts', value: 'x', tokens: [] })] };
    const out = applyRevisionAstBudget({ renderedAst: ast, body: '# small' }, noopWarn);
    expect(out.strippedCount).toBe(0);
    expect((ast.children[0].data as Record<string, unknown>).crowiCode).toBeDefined();
  });

  it('(a) the whole-document measurement is what trips: AST alone under 8MB, but body+yjsUpdate push past the 15MB budget → sidecars strip and the save shape survives', () => {
    // AST ≈ 2MB of sidecar + tiny html — far under AST_INPUT_LIMIT_BYTES.
    const bigSidecar = { tex: 't'.repeat(2 * 1024 * 1024), display: true };
    const ast = { type: 'root', children: [htmlWithSidecar('<div>math</div>', 'crowiMath', bigSidecar), plainHtml('<p>keep</p>')] };
    // body + yjsUpdate occupy ~12.5MB; with 1MB headroom the total sits
    // over the 15MB budget ONLY because of the sidecar bytes.
    const body = 'b'.repeat(10 * 1024 * 1024);
    const yjsUpdateBytes = Math.floor(2.5 * 1024 * 1024);
    const warn = jest.fn();
    const out = applyRevisionAstBudget({ renderedAst: ast, body, yjsUpdateBytes }, warn);
    expect(out.strippedCount).toBe(1);
    // (c) stripped node is byte-identical to the plain (pre-RFC-0023) html node.
    expect(ast.children[0]).toEqual(plainHtml('<div>math</div>'));
    expect(ast.children[1]).toEqual(plainHtml('<p>keep</p>'));
    expect(out.estimatedBytesAfter).toBeLessThanOrEqual(REVISION_BSON_BUDGET_BYTES);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('stripped 1 sidecar');
  });

  it('(b) an AST alone above the 8MB input limit strips even when the whole document would fit', () => {
    const hugeSidecar = { tex: 't'.repeat(9 * 1024 * 1024), display: true };
    const ast = { type: 'root', children: [htmlWithSidecar('<div>m</div>', 'crowiMath', hugeSidecar)] };
    const out = applyRevisionAstBudget({ renderedAst: ast, body: 'tiny' }, noopWarn);
    expect(out.strippedCount).toBe(1);
    expect(ast.children[0]).toEqual(plainHtml('<div>m</div>'));
    expect(out.estimatedBytesAfter - REVISION_FIXED_HEADROOM_BYTES).toBeLessThanOrEqual(AST_INPUT_LIMIT_BYTES);
  });

  it('strips largest-first, stopping as soon as the budget holds', () => {
    const small = { tex: 's'.repeat(100), display: true };
    const large = { tex: 'L'.repeat(9 * 1024 * 1024), display: true };
    const ast = {
      type: 'root',
      children: [htmlWithSidecar('<div>small</div>', 'crowiMath', small), htmlWithSidecar('<div>large</div>', 'crowiMath', large)],
    };
    const out = applyRevisionAstBudget({ renderedAst: ast, body: '' }, noopWarn);
    expect(out.strippedCount).toBe(1);
    // The LARGE one went; the small sidecar survives.
    expect(ast.children[1]).toEqual(plainHtml('<div>large</div>'));
    expect((ast.children[0].data as Record<string, unknown>).crowiMath).toBeDefined();
  });

  it('(d) a page over budget even with zero sidecars is left to fail the way it already does — no throw, nothing else touched', () => {
    const ast = { type: 'root', children: [plainHtml(`<p>${'x'.repeat(1024)}</p>`)] };
    const body = 'b'.repeat(16 * 1024 * 1024); // over budget on its own — today's failure mode
    const before = JSON.stringify(ast);
    const out = applyRevisionAstBudget({ renderedAst: ast, body }, noopWarn);
    expect(out.strippedCount).toBe(0);
    expect(JSON.stringify(ast)).toBe(before);
  });

  it('a JSON.stringify-hostile AST strips ALL sidecars as the fail-safe and does not throw', () => {
    const poisoned: Record<string, unknown> = {
      toJSON: () => {
        throw new Error('poisoned');
      },
    };
    const ast = {
      type: 'root',
      children: [
        htmlWithSidecar('<div>a</div>', 'crowiCode', { value: 'v', tokens: [] }),
        { type: 'html', value: '<div>b</div>', data: { crowiMath: { tex: 'x', display: true }, poison: poisoned } },
      ],
    };
    const warn = jest.fn();
    expect(() => applyRevisionAstBudget({ renderedAst: ast, body: '' }, warn)).not.toThrow();
    for (const child of ast.children as Array<{ data?: Record<string, unknown> }>) {
      for (const key of SIDECAR_KEYS) {
        expect(child.data?.[key]).toBeUndefined();
      }
    }
    expect(String(warn.mock.calls[0][0])).toContain('fail-safe');
  });
});
