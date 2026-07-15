---
"@crowi/web": patch
---

Fold unchanged lines by default in the page history revision diff, GitHub-style: only the changed lines (with 3 lines of surrounding context) render, and unchanged regions collapse behind a click-to-expand indicator. A new toggle next to the existing split/unified view button switches to showing every line, including unchanged context, and back. Comparing two identical revisions now shows a plain "no changes" message instead of a diff container.
