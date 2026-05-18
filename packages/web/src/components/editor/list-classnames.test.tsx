import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LI_CLASSNAME, mergeListClassName, OL_CLASSNAME, UL_CLASSNAME } from './list-classnames';
import { renderMdastToReactNode } from './render-mdast';

/**
 * RFC-0005 — tests for the shared list / task-list class-name helpers
 * and their effect on the rendered markdown.
 *
 * `mergeListClassName` is the fix for #4b: the renderer's `ul` / `ol` /
 * `li` overrides must *merge* the hast `className` (carrying GFM's
 * `contains-task-list` / `task-list-item`) with the Tailwind base
 * classes instead of letting `{...props}` clobber them. The render
 * tests exercise the same component-map shape the show page / preview
 * ship, so a regression in either is caught here.
 */

describe('mergeListClassName', () => {
  it('returns the base class when there is no incoming className', () => {
    expect(mergeListClassName(UL_CLASSNAME, undefined)).toBe(UL_CLASSNAME);
    expect(mergeListClassName(UL_CLASSNAME, null)).toBe(UL_CLASSNAME);
    expect(mergeListClassName(UL_CLASSNAME, '')).toBe(UL_CLASSNAME);
  });

  it('appends a string className from hast', () => {
    expect(mergeListClassName(UL_CLASSNAME, 'contains-task-list')).toBe(`${UL_CLASSNAME} contains-task-list`);
  });

  it('joins an array className from hast (hast-util-to-jsx-runtime form)', () => {
    expect(mergeListClassName(LI_CLASSNAME, ['task-list-item'])).toBe(`${LI_CLASSNAME} task-list-item`);
  });

  it('ignores non-string array entries defensively', () => {
    expect(mergeListClassName(LI_CLASSNAME, [42, 'task-list-item', null])).toBe(`${LI_CLASSNAME} task-list-item`);
  });
});

describe('list / task-list class-name constants', () => {
  it('collapses descendant-list vertical margin so nested lists do not over-space (#3)', () => {
    expect(UL_CLASSNAME).toContain('[&_ul]:my-0');
    expect(UL_CLASSNAME).toContain('[&_ol]:my-0');
    expect(OL_CLASSNAME).toContain('[&_ul]:my-0');
    expect(OL_CLASSNAME).toContain('[&_ol]:my-0');
  });

  it('drops the disc marker on task lists while keeping pl-6 for nesting (#4b)', () => {
    expect(UL_CLASSNAME).toContain('[&.contains-task-list]:list-none');
    expect(UL_CLASSNAME).toContain('pl-6');
    expect(LI_CLASSNAME).toContain('[&.task-list-item]:list-none');
  });

  it('uses the tighter space-y-1 item gap (#3)', () => {
    expect(UL_CLASSNAME).toContain('space-y-1 ');
    expect(UL_CLASSNAME).not.toContain('space-y-1.5');
  });
});

// A components map mirroring the `ul` / `ol` / `li` / `input` overrides
// shipped by `page-content.tsx` and `MarkdownPreview.tsx` — same merge
// + checkbox handling. Render tests below assert the produced DOM.
const listComponents = {
  ul: ({ children, className, ...props }: { children?: React.ReactNode; className?: unknown }) => (
    <ul className={mergeListClassName(UL_CLASSNAME, className)} {...props}>
      {children}
    </ul>
  ),
  li: ({ children, className, ...props }: { children?: React.ReactNode; className?: unknown }) => (
    <li className={mergeListClassName(LI_CLASSNAME, className)} {...props}>
      {children}
    </li>
  ),
  input: ({ type, checked, ...props }: { type?: string; checked?: unknown; [key: string]: unknown }) =>
    type === 'checkbox' ? <input type="checkbox" checked={Boolean(checked)} readOnly {...props} /> : <input type={type} {...props} />,
};

function renderMd(mdast: unknown): string {
  return renderToStaticMarkup(renderMdastToReactNode(mdast, { sectionWrap: false, components: listComponents as never }));
}

describe('task-list rendering through the component map', () => {
  it('keeps the Tailwind padding AND the contains-task-list / task-list-item markers (#4b)', () => {
    const mdast = {
      type: 'root',
      children: [
        {
          type: 'list',
          ordered: false,
          children: [
            {
              type: 'listItem',
              checked: false,
              children: [
                { type: 'paragraph', children: [{ type: 'text', value: 'top' }] },
                {
                  type: 'list',
                  ordered: false,
                  children: [{ type: 'listItem', checked: true, children: [{ type: 'paragraph', children: [{ type: 'text', value: 'nested' }] }] }],
                },
              ],
            },
          ],
        },
      ],
    };
    const html = renderMd(mdast);
    // Base Tailwind padding survives the merge — nested task lists indent.
    expect(html).toContain('pl-6');
    expect(html).toContain('contains-task-list');
    expect(html).toContain('task-list-item');
    // Both the outer and the nested <ul> carry pl-6 (= nesting indent).
    expect(html.match(/pl-6/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('renders task-list checkboxes as controlled, read-only inputs (#4a)', () => {
    const mdast = {
      type: 'root',
      children: [
        {
          type: 'list',
          ordered: false,
          children: [
            { type: 'listItem', checked: false, children: [{ type: 'paragraph', children: [{ type: 'text', value: 'todo' }] }] },
            { type: 'listItem', checked: true, children: [{ type: 'paragraph', children: [{ type: 'text', value: 'done' }] }] },
          ],
        },
      ],
    };
    const html = renderMd(mdast);
    // `readOnly` is present on every checkbox — without it React warns
    // about an uncontrolled→controlled transition.
    const checkboxes = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    expect(checkboxes).toHaveLength(2);
    for (const cb of checkboxes) {
      // `renderToStaticMarkup` keeps the React prop casing (`readOnly`);
      // a real browser lowercases it. Match case-insensitively.
      expect(cb.toLowerCase()).toContain('readonly');
      // `disabled` from the hast properties is preserved.
      expect(cb.toLowerCase()).toContain('disabled');
    }
    // The `- [x]` item renders a `checked` checkbox.
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked[^>]*>/);
  });
});
