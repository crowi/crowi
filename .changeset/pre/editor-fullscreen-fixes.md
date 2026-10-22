---
"@crowi/web": patch
---

Two editor UI fixes. The page-visibility dropdown no longer wraps its
longest option ("anyone with the link") onto a second line — the menu now
grows to fit each label on one line. And the full-screen editor no longer
lets the page micro-scroll a few pixels at the footer: the editor column's
reserved height now accounts for the page-grant accent strip under the
header, so the layout fits the viewport exactly.
