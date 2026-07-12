---
"@crowi/api-contract": minor
"@crowi/api": patch
---

`GET /app/info`'s `capabilities` field is now documented and validated as a closed `Capability` enum (`STATIC_CAPABILITIES` + the three runtime-detected tags `search` / `collab` / `collab:redis`) instead of a generic `string[]`, in both the exported Zod schema and the generated OpenAPI spec. `@crowi/api-contract` exports the new `Capability` type, `CapabilitySchema`, and `DYNAMIC_CAPABILITIES` / `ALL_CAPABILITIES` constants alongside the existing `STATIC_CAPABILITIES`. The `@crowi/api` handler's internal `buildCapabilities()` now returns `Capability[]`, so its literals are compiler-checked against this same vocabulary and the handler and the wire schema can no longer silently drift apart.

`apiVersion` intentionally stays a plain `string` (not narrowed to a `"v2"` literal): the `@crowi/cli` end-user CLI parses `app/info` with a lenient, partial schema parse to implement its WARN-ONLY version-skew note, and a literal type there would make that parse reject the whole response — not just the mismatched field — the moment a future server advertises a different API surface version, silently defeating the very warning it exists to produce.
