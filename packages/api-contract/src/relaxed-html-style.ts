import type { CssNode, Declaration } from 'css-tree';
import { List, generate, ident, parse, walk } from 'css-tree';
import styleToJs from 'style-to-js';

/**
 * Browser/Node shared style filter for the relaxed HTML policy (spec R-2a).
 * There is no property allow-list: only resource references (url / image-set
 * and friends) and variable indirection are dropped, per declaration. The
 * accepted result is the string css-tree generated, and it is re-read with the
 * very parser the renderer uses (`style-to-js` via `hast-util-to-jsx-runtime`)
 * so a disagreement between the two parsers fails the whole attribute closed.
 */

const FORBIDDEN_FUNCTIONS: ReadonlySet<string> = new Set([
  'url',
  'image-set',
  '-webkit-image-set',
  'image',
  'cross-fade',
  'element',
  'paint',
  'var',
  'env',
  'attr',
  'src',
  'expression',
]);

const FORBIDDEN_PROPERTIES: ReadonlySet<string> = new Set(['behavior', '-moz-binding']);

const SAFE_PROPERTY_RE = /^-?[a-z][a-z0-9-]*$/;
const MS_PREFIX_RE = /^-ms-/;
const HYPHEN_RE = /-([a-z])/g;

/** The key `style-to-js` (reactCompat) gives a lowercase property. */
function reactPropertyName(property: string): string {
  if (!property.includes('-')) return property;
  return property.replace(MS_PREFIX_RE, 'ms-').replace(HYPHEN_RE, (_match, ch: string) => ch.toUpperCase());
}

function hasForbiddenValue(declaration: Declaration): boolean {
  let forbidden = false;
  walk(declaration.value, (node: CssNode) => {
    if (forbidden) return;
    if (node.type === 'Url' || node.type === 'Raw') {
      forbidden = true;
    } else if (node.type === 'Function' && FORBIDDEN_FUNCTIONS.has(ident.decode(node.name).toLowerCase())) {
      forbidden = true;
    }
  });
  return forbidden;
}

function sanitize(value: string): string | undefined {
  const ast = parse(value, { context: 'declarationList', parseCustomProperty: true });
  if (ast.type !== 'DeclarationList') return undefined;

  const kept: Declaration[] = [];
  const expected = new Map<string, string>();
  ast.children.forEach((child) => {
    if (child.type !== 'Declaration') return;
    const rawName = ident.decode(child.property).toLowerCase();
    if (rawName.startsWith('--') || FORBIDDEN_PROPERTIES.has(rawName)) return;
    if (child.value.type === 'Raw' || hasForbiddenValue(child)) return;
    kept.push(child);
  });
  if (kept.length === 0) return undefined;

  const output = new List<Declaration>();
  for (const declaration of kept) {
    const name = ident.decode(declaration.property).toLowerCase();
    if (!SAFE_PROPERTY_RE.test(name)) return undefined;
    const copy: Declaration = { type: 'Declaration', important: declaration.important, property: name, value: declaration.value };
    const generated = generate(copy);
    const expectedValue = generated.slice(name.length + 1);
    const key = reactPropertyName(name);
    if (expectedValue === '' || expected.has(key)) return undefined;
    expected.set(key, expectedValue);
    output.appendData(copy);
  }

  const serialized = generate({ type: 'DeclarationList', children: output });
  const reparsed = styleToJs(serialized, { reactCompat: true }) as Record<string, unknown>;
  const keys = Object.keys(reparsed);
  if (keys.length !== expected.size) return undefined;
  for (const [key, expectedValue] of expected) {
    if (!Object.prototype.hasOwnProperty.call(reparsed, key) || reparsed[key] !== expectedValue) return undefined;
  }
  return serialized;
}

/**
 * Returns the safe style string, or `undefined` when the attribute must be
 * omitted (not a string, nothing left, or the two parsers disagree).
 */
export function sanitizeRelaxedStyle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return sanitize(value);
  } catch {
    return undefined;
  }
}
