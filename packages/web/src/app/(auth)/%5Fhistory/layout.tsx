/**
 * History-page layout. Widens beyond the parent `(auth)` layout's
 * `max-w-4xl` centred column so the revision diff has the full viewport
 * to render side-by-side changes — at the narrow column width long lines
 * wrap and the diff becomes hard to read.
 *
 * Same viewport-wide escape as `_edit/layout.tsx`: `mx-[calc(50%-50vw)]`
 * re-centres the inner block on the viewport origin and `w-screen`
 * stretches it across. We then re-supply our own horizontal gutters
 * (`px-4 …`) since the parent's `px-4` is escaped by the negative margin.
 *
 * Unlike `_edit`, the history view scrolls normally, so we do NOT pin to
 * the viewport height or hide overflow — only the width changes. The
 * parent's vertical `py-8` still applies (our div sits inside `main`),
 * so vertical rhythm is preserved.
 */
export default function HistoryLayout({ children }: { children: React.ReactNode }) {
  return <div className="mx-[calc(50%-50vw)] w-screen px-4 sm:px-6 lg:px-8 overflow-x-hidden">{children}</div>;
}
