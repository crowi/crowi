---
"@crowi/web": patch
---

The admin user list now marks a federated identity with the provider's own brand mark (the Google "G" for a Google identity) instead of a generic link icon, so an admin can see which service a user is connected to without opening the row menu. A user with several linked providers gets one mark each, and a provider Crowi ships no mark for keeps the link icon — the marks are the same inline SVGs the sign-in screen draws, so no third-party host is contacted to render the page.
