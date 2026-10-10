---
"@crowi/api": patch
---

Update the dependencies sharp to 0.35.5, which ships a librsvg with a fixed vulnerability, and the MCP TypeScript SDK to 1.32.1, which fixes an advisory in its OAuth client. Crowi uses the SDK only as an MCP server, so it did not reach that client code.
