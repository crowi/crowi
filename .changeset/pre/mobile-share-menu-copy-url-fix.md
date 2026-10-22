---
"@crowi/web": patch
---

Fix the mobile page-actions menu's share item, which was mislabeled "Title + URL" while silently copying just the bare URL with no confirmation or way to grab the title/Markdown variants.

It's now labeled "Copy URL" and opens the same share panel as the desktop link-share popover in a modal: the id URL is still auto-copied the instant it opens (with the "URL Copied!" confirmation), and the panel also offers "Title + URL" and Markdown rows with their own copy buttons — matching the desktop experience exactly, since both surfaces now share one panel component.
