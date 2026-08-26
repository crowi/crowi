'use client';

import type { TocEntryResponse } from '@crowi/api-contract';
import { cn } from '@/lib/utils';
import { PageToc } from './page-toc';

/**
 * The page's 3-column reading shell: a left spacer reserving the fixed nav
 * rail's width, the centered content column (max-w-4xl), and the right TOC
 * rail. Escapes the parent's centered `max-w-4xl` main with a `w-screen`
 * group (margins/flex, no transform, so the sticky rail + fixed compact
 * header stay viewport-relative) and re-centres the content as a
 * `[spacer | content | toc]` triple.
 *
 * The left spacer (≥1440) reserves the fixed nav rail's width so the content
 * stays dead-centre; below 1440 it collapses and content + TOC re-centre as a
 * pair; below 1280 the TOC column hides (the header `PageTocMenu` takes over).
 * The right column stays reserved at ≥1440 even with no TOC so a
 * heading-light page is still symmetric.
 *
 * `railActions` is pinned under the TOC inside the same sticky block (the
 * TOC list scrolls, the actions do not). Its visibility rides on the TOC
 * column's breakpoints deliberately: whether it has anything to draw is the
 * action's own business (an empty-bodied page's copy button renders null),
 * which this column cannot see, so it must not gate the column on it.
 * Narrower viewports reach the same actions through the page dotmenu.
 *
 * Shared by the single-page view (`PageView`) and the portal listing
 * (`PageList`), so both render the same TOC rail over their body's headings.
 * Children own their vertical rhythm (the slot adds none).
 */
export function PageTocColumns({
  toc,
  activeTocId,
  railActions,
  children,
}: {
  toc: TocEntryResponse[];
  activeTocId: string | null;
  /** Page-level controls pinned under the TOC (see this file's header). */
  railActions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const hasToc = toc.length >= 2;
  return (
    <div className="mx-[calc(50%-50vw)] flex w-screen justify-center gap-6 px-4">
      <div aria-hidden className="hidden w-56 shrink-0 min-[1440px]:block" />
      <div className="w-full min-w-0 max-w-4xl">{children}</div>
      <div className={cn('w-56 shrink-0', hasToc ? 'hidden min-[1280px]:block' : 'hidden min-[1440px]:block')}>
        <div className="sticky top-24 flex max-h-[calc(100vh-7rem)] flex-col gap-3">
          {hasToc && <PageToc toc={toc} activeId={activeTocId} />}
          {railActions}
        </div>
      </div>
    </div>
  );
}
