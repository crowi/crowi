---
'@crowi/web': patch
---

Fix the page becoming unclickable after closing a rename or delete dialog
opened from an actions ("...") menu — on a page, and on items/folders in page
lists. A modal Radix dropdown and a modal Radix dialog each toggle
`pointer-events: none` on `<body>`; when the dialog opened as the menu closed,
their add/remove races left the style stuck on `<body>`, blocking all clicks.
Those menus are now non-modal, so only the dialog manages body pointer-events
and it is cleaned up correctly on close.
