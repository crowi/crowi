---
"@crowi/api": patch
"@crowi/plugin-mail-smtp": patch
---

Update the dependencies zod to 4.6.7 and nodemailer to 10.2.1, and move undici, body-parser and fast-uri to patched releases. These fix advisories in those packages: memory exhaustion in zod when validating oversized constrained collections, recipient parsing errors in nodemailer's address parser, denial of service in body-parser through trailing bytes after a compressed request body, denial of service in undici through excessive content encodings or an unbounded event stream along with a Subresource Integrity bypass, and URI parsing errors in fast-uri.
