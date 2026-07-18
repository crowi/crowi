---
"@crowi/plugin-renderer-mermaid": minor
"@crowi/plugin-renderer-svg-sanitize": minor
"@crowi/api": minor
"@crowi/web": minor
"@crowi/plugin-api": minor
---

Add server-side Mermaid diagram rendering (RFC-0002 Phase 6.1).

New `@crowi/plugin-renderer-mermaid` plugin: ` ```mermaid ` fenced code blocks are rendered entirely server-side in an isolated, network-denied child process (no client-side Mermaid JS ever ships to the browser) and embedded as a sanitized, base64-encoded SVG `<img>`. Supports flowchart, sequence, class, state, ER, journey, pie, and git-graph diagrams, with a shared, independently-tested DOM-based SVG sanitizer (new `@crowi/plugin-renderer-svg-sanitize` package) that also replaces `@crowi/plugin-renderer-plantuml`'s previous regex-only sanitizer. No operator configuration is required, and existing pages keep rendering their `mermaid` fences as plain code blocks until the author explicitly re-saves them.

The editor's live preview now renders Mermaid diagrams as you type, not just after saving: a new `previewPolicy` opt-in on `CodeBlockRenderer` lets a renderer participate in non-persistent preview rendering (page-less, no cache writes), gated by the same per-user admission-control concurrency limits and priority scheduling used for saved-page rendering, plus a per-user rate limit on the preview endpoint and proper request cancellation when a newer keystroke supersedes an in-flight preview.

The page-view diagram wrapper (click-to-enlarge, cap-to-width, dark-mode-neutral surface) is generalized from PlantUML-only to any diagram renderer, so Mermaid diagrams get the same affordance PlantUML diagrams already had.
