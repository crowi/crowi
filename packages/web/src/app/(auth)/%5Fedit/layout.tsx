/**
 * Edit-page layout. Two jobs:
 *
 * 1. **Widen** beyond the parent `(auth)` layout's `max-w-4xl` centred
 *    column. The 2-column editor + preview wants the whole viewport;
 *    refactoring the shared layout would touch ~11 show-side surfaces,
 *    so we use a viewport-wide escape: `mx-[calc(50%-50vw)]` re-centres
 *    the inner block on the viewport origin, `w-screen` stretches it
 *    across, and `-my-8` cancels the parent's `py-8`.
 *
 * 2. **Pin** the page to the viewport so the inner header / footer can
 *    sticky-stick and the editor / preview can claim the remaining
 *    height for their own scroll. `h-[calc(100dvh-3.5rem)]` reserves
 *    the height between the global header and the viewport bottom
 *    (3.5rem ≈ the auth-layout header). `100dvh` (not `100vh`) tracks
 *    mobile URL-bar changes so the editor doesn't poke past the screen.
 *
 * Scrollbar caveat: a vertical scrollbar pushes `100vw` past the
 * actual content box. With `overflow-hidden` we don't generate a
 * page-level scrollbar in the first place (the editor / preview own
 * their internal scroll), so this is moot here — but we keep
 * `overflow-x-hidden` defensively in case a long preview line bleeds.
 *
 * Refactoring the parent layout to drop the `max-w-4xl` is tracked as
 * a separate task — see `feature-editor-foundation.json` openQuestions.
 */
export default function EditLayout({ children }: { children: React.ReactNode }) {
  return <div className="mx-[calc(50%-50vw)] flex h-[calc(100dvh-3.5rem)] w-screen flex-col -my-8 overflow-x-hidden overflow-y-hidden">{children}</div>;
}
