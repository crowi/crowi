---
'@crowi/web': patch
---

Fix the admin user list becoming unclickable after closing a dialog opened from a row's action menu — resetting a password, editing a user, or changing an email address left the whole page unresponsive behind an invisible overlay, with a reload the only way out.
