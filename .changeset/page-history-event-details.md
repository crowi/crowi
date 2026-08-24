---
"@crowi/api-contract": patch
"@crowi/web": patch
---

Show the concrete details behind page-history metadata events. Rename rows now include the previous and new paths plus whether a redirect was created, visibility rows name both the previous and new sharing levels, trash rows show the path the page left, and restore rows show the path it returned to. Malformed or older event payloads continue to render their summary without a detail instead of breaking the history screen.
