/**
 * RFC-0005 — shared list / task-list class names for the markdown
 * renderer's `ul` / `ol` / `li` component overrides.
 *
 * Both the show page (`page-view/page-content.tsx`) and the editor
 * preview (`editor/markdown-preview.tsx`) render server-emitted mdast
 * through the same `renderMdastToReactNode` pipeline, so their list
 * styling must stay identical. These constants are the single source
 * of truth — a plain constant, not an abstraction layer.
 *
 * Two fixes are baked in here:
 *
 *  - **Nested-list spacing (#3).** `my-4` on every `ul` / `ol` makes
 *    nested lists open up a full 1rem above/below their parent item.
 *    `[&_ul]:my-0 [&_ol]:my-0` zeroes the vertical margin on any
 *    descendant list so only the outermost list keeps the `my-4`
 *    block spacing.
 *
 *  - **Task-list rendering (#4b).** `remark-gfm` emits task lists with
 *    `class="contains-task-list"` on the `<ul>` and
 *    `class="task-list-item"` on each `<li>`. The renderer's component
 *    overrides must *merge* that class (see `mergeListClassName`) — the
 *    previous code let the hast `className` from `{...props}` clobber
 *    the Tailwind classes, so task lists lost their padding entirely
 *    (no indentation, nested task lists flush-left). The
 *    `[&.contains-task-list]` variants drop the disc marker for task
 *    lists (the checkbox is the marker) while keeping `pl-6` so nested
 *    task lists still indent.
 */

/**
 * `ul` class names. `list-disc` + `pl-6` for normal bullet lists;
 * `[&.contains-task-list]:list-none` removes the disc when the list
 * is a GFM task list (the checkbox stands in for the marker). `pl-6`
 * is kept for task lists too so nested task lists are visibly
 * indented. `[&_ul]:my-0 [&_ol]:my-0` collapses the vertical margin
 * on descendant lists at any depth.
 */
export const UL_CLASSNAME = 'list-disc pl-6 my-4 space-y-1 marker:text-foreground/40 [&.contains-task-list]:list-none [&_ul]:my-0 [&_ol]:my-0';

/** `ol` class names — same spacing rules as {@link UL_CLASSNAME}. */
export const OL_CLASSNAME = 'list-decimal pl-6 my-4 space-y-1 marker:text-foreground/40 [&_ul]:my-0 [&_ol]:my-0';

/**
 * `li` class names. `[&.task-list-item]:list-none` drops the disc on
 * a task-list item; `[&>input]:mr-1.5` gives the inline checkbox a
 * little breathing room from its label text.
 */
export const LI_CLASSNAME = 'leading-relaxed [&>p]:my-1 [&.task-list-item]:list-none [&>input]:mr-1.5';

/**
 * Merge a renderer-supplied `className` (from the hast `properties`,
 * delivered via the component's rest-props bag) with one of the
 * constants above. The hast value can be a `string` or an array of
 * strings (`hast-util-to-jsx-runtime` may pass either). Returning the
 * combined string — and *not* spreading `props.className` after — is
 * what keeps `contains-task-list` / `task-list-item` available to the
 * `[&.…]` Tailwind variants without it overwriting the base classes.
 */
export function mergeListClassName(base: string, incoming: unknown): string {
  if (typeof incoming === 'string' && incoming.length > 0) return `${base} ${incoming}`;
  if (Array.isArray(incoming)) {
    const joined = incoming.filter((c): c is string => typeof c === 'string').join(' ');
    return joined ? `${base} ${joined}` : base;
  }
  return base;
}
