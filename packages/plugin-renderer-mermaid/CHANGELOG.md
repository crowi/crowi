# @crowi/plugin-renderer-mermaid

## 0.1.0-alpha.2

### Minor Changes

- d680c0c: Add server-side Mermaid diagram rendering (RFC-0002 Phase 6.1).

  New `@crowi/plugin-renderer-mermaid` plugin: ` ```mermaid ` fenced code blocks are rendered entirely server-side in an isolated, network-denied child process (no client-side Mermaid JS ever ships to the browser) and embedded as a sanitized, base64-encoded SVG `<img>`. Supports flowchart, sequence, class, state, ER, journey, pie, and git-graph diagrams, with a shared, independently-tested DOM-based SVG sanitizer (new, private `@crowi/svg-sanitize` package) that also replaces `@crowi/plugin-renderer-plantuml`'s previous regex-only sanitizer. No operator configuration is required, and existing pages keep rendering their `mermaid` fences as plain code blocks until the author explicitly re-saves them.

  The editor's live preview now renders Mermaid diagrams as you type, not just after saving: a new `previewPolicy` opt-in on `CodeBlockRenderer` lets a renderer participate in non-persistent preview rendering (page-less, no cache writes), gated by the same per-user admission-control concurrency limits and priority scheduling used for saved-page rendering, plus a per-user rate limit on the preview endpoint and proper request cancellation when a newer keystroke supersedes an in-flight preview.

  The page-view diagram wrapper (click-to-enlarge, cap-to-width, dark-mode-neutral surface) is generalized from PlantUML-only to any diagram renderer, so Mermaid diagrams get the same affordance PlantUML diagrams already had.

### Patch Changes

- 1825a1a: The shared SVG sanitizer moved from the published `@crowi/plugin-renderer-svg-sanitize` package to a private, internal-only `@crowi/svg-sanitize` package that is now bundled directly into each renderer's `dist` at build time instead of being installed as a runtime dependency. Sanitization behaviour is unchanged; only the dependency graph of the published package changed (the workspace dependency moved to `devDependencies`, and `@xmldom/xmldom` is now declared directly as a `dependencies` entry of each renderer instead of being resolved transitively).
- Updated dependencies [df1ce77]
- Updated dependencies [05648c0]
- Updated dependencies [d680c0c]
- Updated dependencies [a32204f]
- Updated dependencies [b0e2c76]
  - @crowi/plugin-api@1.0.0-alpha.4
