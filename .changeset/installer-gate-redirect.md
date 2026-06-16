---
'@crowi/web': patch
---

Always redirect to the installer when the instance is not yet installed. The
`InstallerGate` previously rendered the requested page (login / register /
wiki) while the install-status check was still loading and even while the
redirect to `/installer` was in flight, so a fresh, not-yet-installed instance
would briefly show a usable-looking login form. The gate now holds back the
page behind a loading state until the status is known and only reveals
`children` once the instance is confirmed installed (or the user is legitimately
on `/installer`). A per-origin "installed" flag is cached so already-installed
instances skip the gate on subsequent loads without an extra round-trip.
