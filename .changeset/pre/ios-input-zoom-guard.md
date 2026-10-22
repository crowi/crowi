---
'@crowi/web': patch
---

Stop iOS Safari from zooming the viewport when focusing the page search box or
the editor. A theme-level rule now enforces a 16px minimum font-size on all
editable surfaces (inputs, textareas, selects, contenteditable, and the
CodeMirror editor) on iOS only, so every current and future mobile screen is
zoom-safe without per-component overrides. Non-iOS sizing is unchanged.
