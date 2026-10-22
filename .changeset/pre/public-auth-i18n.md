---
"@crowi/web": minor
---

Localize the public auth screens (en / ja).

The sign-in, registration, and the new invite-accept / activate /
password-reset / forgot-password / email-change-confirm pages had Japanese
copy hardcoded in the components. Their titles, labels, buttons, and
error/empty states now go through paraglide (`auth.*` messages) so they
render in the viewer's language.
