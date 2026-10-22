---
"@crowi/api": minor
"@crowi/api-contract": minor
"@crowi/web": minor
---

Render a document-leading YAML frontmatter block as a muted key/value table instead of letting it fall through as a broken horizontal rule and paragraph.

Pages that start with a `---`-delimited frontmatter block (common when pasting a spec, RFC, or other document with metadata headers) used to render that block as a mangled paragraph, since the renderer had no concept of frontmatter at all. The pipeline now parses a document-leading `---` block, scans it line-by-line into an ordered list of key/value entries (never a full YAML parse, so there is no anchor/alias expansion attack surface), and displays it as a compact two-column table above the body. A frontmatter block that is empty renders nothing; one that is malformed, or exceeds a bounded size, is preserved verbatim as a fenced `yaml` code block so no content is ever lost. A `---` anywhere other than the very first line of the document is unaffected and still renders as an ordinary horizontal rule. Existing pages pick up the new rendering the next time they're viewed; an operator can also run `crowi-admin rebuild rendered-ast` to backfill the stored copy in bulk.
