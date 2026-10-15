import type { LNode } from './model';
import { MAX_INPUT_UTF8_BYTES, isRecord, utf8Length } from './model';

type Failure = 'invalid-input' | 'resource-limit';

const STRING_VALUE_TYPES: ReadonlySet<string> = new Set(['text', 'raw', 'html', 'comment', 'doctype', 'code', 'inlineCode']);

/**
 * Shape and size gate shared by mdast (before `toHast`) and HAST (before
 * parsing): rejects cycles and malformed nodes, and caps the total UTF-8 size
 * of every string in the tree. Iterative on purpose — nesting depth is not
 * limited, so a deeply nested document must not overflow the call stack here.
 */
export function validateWebRenderInput(value: unknown): Failure | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return 'invalid-input';

  let bytes = 0;
  const onPath = new Set<object>();
  // Entries are either a value to enter, or `null` marking "leave the node pushed before".
  const stack: Array<{ node: object; exit: boolean }> = [{ node: value, exit: false }];

  const addString = (s: string): boolean => {
    bytes += utf8Length(s);
    return bytes <= MAX_INPUT_UTF8_BYTES;
  };

  while (stack.length > 0) {
    const entry = stack.pop() as { node: object; exit: boolean };
    if (entry.exit) {
      onPath.delete(entry.node);
      continue;
    }
    const node = entry.node as Record<string, unknown>;
    if (onPath.has(node)) return 'invalid-input';
    onPath.add(node);
    stack.push({ node, exit: true });

    if (typeof node.type !== 'string') return 'invalid-input';
    if (!addString(node.type)) return 'resource-limit';
    if (node.type === 'element') {
      if (typeof node.tagName !== 'string') return 'invalid-input';
      if (node.properties !== undefined && !isRecord(node.properties)) return 'invalid-input';
    }
    if (STRING_VALUE_TYPES.has(node.type) && node.value !== undefined && typeof node.value !== 'string') return 'invalid-input';
    if (node.children !== undefined && !Array.isArray(node.children)) return 'invalid-input';
    if (node.content !== undefined && !isRecord(node.content)) return 'invalid-input';

    for (const key of Object.keys(node)) {
      if (key === 'position' || key === 'type') continue;
      const field = node[key];
      if (field === undefined || field === null) continue;
      if (typeof field === 'string') {
        if (!addString(field)) return 'resource-limit';
      } else if (key === 'children' && Array.isArray(field)) {
        const children = field as unknown[];
        for (let i = children.length - 1; i >= 0; i -= 1) {
          const child = children[i];
          if (!isRecord(child) || typeof child.type !== 'string') return 'invalid-input';
          stack.push({ node: child, exit: false });
        }
      } else if (typeof field === 'object' && field !== null) {
        // properties / data / content / lists of strings: scan generically.
        if (key === 'content') {
          stack.push({ node: field, exit: false });
        } else {
          const failure = scanPlain(field, node, addString, onPath);
          if (failure) return failure;
        }
      }
    }
  }
  return undefined;
}

function scanPlain(root: object, owner: object, addString: (s: string) => boolean, onPath: Set<object>): Failure | undefined {
  const seen = new Set<object>([owner]);
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === 'string') {
      if (!addString(current)) return 'resource-limit';
      continue;
    }
    if (typeof current !== 'object' || current === null) continue;
    if (onPath.has(current)) return 'invalid-input';
    if (seen.has(current)) continue;
    seen.add(current);
    for (const v of Array.isArray(current) ? current : Object.values(current)) stack.push(v);
  }
  return undefined;
}

export type { LNode };
