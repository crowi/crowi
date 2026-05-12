/**
 * Edit-page layout. The parent `(auth)` layout pins the content area
 * to a `max-w-4xl` centred column, which is right for page show but
 * leaves the 2-column editor + preview cramped. Rather than refactor
 * the shared layout (it would touch ~11 show-side surfaces), we wrap
 * the edit children in a viewport-wide escape using the
 * `mx-[calc(50%-50vw)]` + `w-screen` pattern: the negative horizontal
 * margin re-centres the inner block back to the viewport origin, and
 * `w-screen` stretches it back across the full viewport width. The
 * `-my-8` cancels the parent's `py-8`, regaining the vertical room.
 *
 * Scrollbar caveat: a vertical scrollbar pushes `100vw` past the
 * actual content box, producing a horizontal scroll. The 2-column
 * editor body itself shouldn't generate one (CodeMirror manages its
 * own scrollbars internally) but defensive `overflow-x-hidden` on
 * the wrapper keeps stray horizontal bleed (e.g. long-line preview
 * code blocks) contained.
 *
 * Refactoring the parent layout to drop the `max-w-4xl` is tracked as
 * a separate task — see `feature-editor-foundation.json` openQuestions.
 */
export default function EditLayout({ children }: { children: React.ReactNode }) {
  return <div className="mx-[calc(50%-50vw)] w-screen -my-8 px-4 py-6 overflow-x-hidden">{children}</div>;
}
