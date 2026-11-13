---
"@crowi/api": patch
"@crowi/api-contract": patch
---

Updated hono to 4.13.18, which fixes vulnerabilities reported in hono: the default router could skip wildcard middleware for some route sets and for paths containing an encoded line terminator, `mount()` could forward a path that bypassed middleware scoped inside the mount prefix, `validator('form')` skipped validation for some `multipart/form-data` requests, `csrf()` did not check hyperlink-auditing requests, and the `css` helper did not escape a closing tag split across an interpolated value. Crowi uses the default router, so the first applied; it does not use `mount()`, the form validator, `csrf()` or the `css` helper, so the others were not reached.
