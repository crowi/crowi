---
"@crowi/api-contract": patch
"@crowi/api": patch
"@crowi/web": patch
---

A fresh install no longer flips from Japanese to English with a page reload right after setup. Without a language cookie the web app now picks the language from the browser's Accept-Language header, and accounts created through the installer, self-registration, invitations and external sign-in start with that language instead of always English.
