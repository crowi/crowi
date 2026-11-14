---
"@crowi/api": patch
"@crowi/plugin-search-mongo": patch
---

Updated mongoose to 9.12.1, which fixes vulnerabilities reported in mongoose: prototype pollution through `Schema.prototype.virtual()`, inherited properties being walked when hydrating, setting and merging documents, discriminator key values that match inherited properties bypassing schema casting, and `sanitizeFilter` not being applied to `countDocuments` or when set on a connection. Crowi does not enable `sanitizeFilter`, so the last two were not reached.
