---
'@crowi/api': patch
'@crowi/api-contract': patch
'@crowi/web': patch
'@crowi/plugin-api': patch
'@crowi/plugin-mail-smtp': patch
'@crowi/plugin-slack': patch
'@crowi/plugin-renderer-katex': patch
---

Close 20 security advisories, including a critical one. Next.js moves to 16.3.3, which fixes unauthenticated remote code execution through the image optimization API when it handles AVIF files, and a second unauthenticated path that only affects Windows-hosted servers. Hono moves to 4.13.5 or later, nodemailer to 9.1.1, sharp to 0.35.4, and js-yaml to 4.3.2 on the 4.x line and 3.15.2 on the 3.x one. Three dependencies Crowi does not declare itself — svgo, baseline-browser-mapping and the 3.x js-yaml — are pinned to their patched versions, because no parent of theirs offers a version that already resolves there.
