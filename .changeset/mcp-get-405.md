---
"@crowi/api": patch
---

The MCP endpoint now answers `GET` with 405 instead of opening the server-to-client stream, so the listening stream that MCP clients keep open no longer makes the api's memory grow over time.
