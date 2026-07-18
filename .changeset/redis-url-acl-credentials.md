---
"@crowi/api": patch
---

Forward the ACL username from `REDIS_URL` (`redis://user:pass@host`): it was silently dropped, so the api's Redis clients authenticated as the `default` user while the realtime-collab path authenticated as the URL's ACL user. Both URL parsers also moved to the WHATWG URL API so percent-encoded credentials decode exactly once and passwords containing `:` or `@` keep their username/password boundary (the legacy parser pre-decoded the userinfo and could corrupt such credentials).
