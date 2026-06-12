---
"@crowi/web": minor
---

Fix the installer re-showing after a successful first-run install, and add post-install onboarding. Creating the first admin now signs them in, lands on `/admin` with a one-shot congratulations dialog, and shows a setup checklist (storage / search / mail / users). Logging in with no explicit `?continue=` target now lands on the user's own page (`/user/<username>`) instead of the site root.
