---
'@crowi/web': minor
---

Add a "Create Portal" CTA and a "What is Portal?" help dialog to
portal-less folder paths. When a trailing-slash path (e.g. `/project/`)
has no portal page yet, the page list now offers a way to create one
(routing to the standard `/_edit?path=` create flow at the portal path),
reproducing the legacy `page_list.html` "Create Portal" side button.

A draft portal is no longer shown as the portal: it is visible only to
its creator (RFC-0004) and has no committed revision to render (it
showed a perpetual "Rendering…"). Instead, when the current user has a
draft portal in progress here, the folder header shows a "portal in
progress" notice with a "Continue editing" button into its draft editor;
drafts owned by others fall back to the create CTA.
