---
"@crowi/web": patch
---

Fixed the trash page list (`/trash/...`) double-decoding legacy `+`-joined path segments, which could mangle deleted pages whose name used the `+`-as-space URL convention.
