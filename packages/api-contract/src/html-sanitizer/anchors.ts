import type { LNode } from './model';
import { utf8Length } from './model';

/**
 * Names an author id/name may never take: DOM/Window properties that a named
 * element would shadow, plus the ids the Web app looks up with
 * `getElementById`. A fixed list (not `value in window`) so the result is the
 * same on the server, in the browser and across re-renders.
 */
export const CLOBBERING_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'window',
  'self',
  'document',
  'location',
  'cookie',
  'name',
  'top',
  'parent',
  'frames',
  'length',
  'opener',
  'navigator',
  'history',
  'screen',
  'closed',
  'close',
  'open',
  'alert',
  'confirm',
  'prompt',
  'console',
  'fetch',
  'localStorage',
  'sessionStorage',
  'body',
  'head',
  'forms',
  'images',
  'links',
  'anchors',
  'scripts',
  'title',
  'URL',
  'domain',
  'referrer',
  'defaultView',
  'getElementById',
  'getElementsByName',
  'createElement',
  'write',
  'writeln',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'rename-new-path',
  'comments-heading',
  'backlinks-heading',
]);

export const MAX_ANCHOR_UTF8_BYTES = 256;

/** Identity of elements whose id/name came from the renderer, not from the author. */
export interface AnchorProvenance {
  /** Elements inside a composed generated fragment (never filtered). */
  generated: WeakSet<object>;
  /** Elements whose id/name were restored from the structure owner table. */
  owned: WeakSet<object>;
}

function walkElements(node: LNode, visit: (element: LNode) => boolean | void): void {
  const stack: LNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as LNode;
    if (current.type === 'element') {
      if (visit(current) === false) continue;
    }
    const children = current.children;
    if (children) for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i] as LNode);
  }
}

/** Every id/name value a generated structure or fragment provides (the collision space for authors). */
export function collectGeneratedAnchorValues(tree: LNode, provenance: AnchorProvenance): Set<string> {
  const values = new Set<string>();
  walkElements(tree, (element) => {
    const props = element.properties ?? {};
    const isGenerated = provenance.generated.has(element);
    const isOwned = provenance.owned.has(element);
    if (isGenerated || isOwned) {
      for (const key of ['id', 'name', 'dataSectionId']) {
        const value = props[key];
        if (typeof value === 'string' && value !== '') values.add(value);
      }
    }
  });
  return values;
}

/**
 * Keeps an author id/name only if it is a valid, unique, non-clobbering value
 * that does not collide with a generated anchor. Document order; within one
 * element id is judged before name; id and name share one collision space.
 */
export function filterAuthorAnchorAttributes(tree: LNode, generatedValues: ReadonlySet<string>, provenance: AnchorProvenance): void {
  const kept = new Set<string>();
  walkElements(tree, (element) => {
    if (provenance.generated.has(element)) return false;
    if (provenance.owned.has(element)) return;
    const props = element.properties;
    if (!props) return;
    for (const key of ['id', 'name'] as const) {
      if (!(key in props)) continue;
      const value = props[key];
      const ok =
        typeof value === 'string' &&
        value !== '' &&
        utf8Length(value) <= MAX_ANCHOR_UTF8_BYTES &&
        !generatedValues.has(value) &&
        !kept.has(value) &&
        !CLOBBERING_NAMES.has(value);
      if (!ok) delete props[key];
      else kept.add(value as string);
    }
  });
}
