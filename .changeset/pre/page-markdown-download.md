---
"@crowi/web": patch
---

Add a "Download markdown" action to the page actions menu, right below "Copy markdown", so a page's current revision body can be saved as a `.md` file without going through the clipboard first. The filename is derived from the page's last path segment (Unicode preserved, filesystem-unsafe characters replaced with a hyphen, falling back to the page id when no usable segment exists); an empty body downloads nothing, matching the existing copy action's no-op behavior.
