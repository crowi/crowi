---
"@crowi/web": patch
---

The rename dialog no longer undoes a select-all made in the new-path field right after it opens. Selecting everything with Ctrl/Cmd+A and typing or pasting a path within the first moments used to snap the selection back to the page name, so the new path landed after the old parent path (`/a/b//a/b-new`) and the server refused it; only the select-all the dialog's own focus handling performs when focus returns to the field is narrowed to the page name now.
