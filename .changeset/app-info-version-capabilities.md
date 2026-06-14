---
'@crowi/api-contract': minor
---

Extend the public `GET /api/v2/app/info` response with a version-skew /
feature-detection signal: `version` (the running server version), `apiVersion`
(`"v2"`), and `capabilities` (a coarse list of exposed subsystems — the
always-on set plus dynamically-detected ones such as `search` when a search
driver is active and `collab` / `collab:redis`). The existing `title` /
`confidential` fields are unchanged, and clients that ignore the new fields keep
working. This is the signal the `crowi` end-user CLI reads to tolerate version
drift across self-hosted instances.
