---
"@crowi/web": patch
---

Reading a page now offers a "Copy markdown" button pinned under the table of contents, so handing a whole page to an AI assistant no longer costs a trip through the page actions menu. The button copies the same markdown source as the existing menu item (which stays where it is) and confirms on itself rather than through a toast; it appears on portals too, and is absent for a page with an empty body. Viewports too narrow for the TOC rail keep reaching the action through the actions menu.
