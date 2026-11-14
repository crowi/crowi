---
"@crowi/api": patch
---

Updated @hono/node-server to 2.1.8, which fixes vulnerabilities reported in @hono/node-server: a backslash in the request path was read as a path separator, so a request could reach a path that a reverse proxy's path-based rules did not apply to (such requests are now rejected with `400 Bad Request`), and a connection reset during an asynchronous WebSocket upgrade could crash the process. Crowi handles its WebSocket upgrades itself rather than through @hono/node-server, so the second was not reached.
