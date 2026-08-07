---
"@crowi/web": patch
"@crowi/plugin-slack": patch
---

Fix plugins disappearing from the admin sidebar. A plugin whose `adminPlacement.section` named a section the sidebar has no heading for — `auth` or `notification`, both of which the plugin contract allows — was dropped instead of placed, leaving its settings page reachable only by typing the URL. Auth-provider plugins hit this by default, since the section is inferred from `registerAuth`. Such entries now fall back to the general settings group. Google and Slack also get their real logos in the sidebar and, for Google, on the sign-in button, replacing the generic key and share glyphs.
