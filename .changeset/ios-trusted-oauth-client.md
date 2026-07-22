---
"@crowi/api-contract": minor
---

Seed a trusted first-party `crowi-ios` OAuth client (RFC-0016 Phase 0) alongside the existing `crowi-cli` one. The redirect-uri validator now accepts an exact-match custom URI scheme (`crowi-ios://callback`) only for clients that are both `trusted` and first-party — every other client, including `crowi-cli`, keeps the existing http(s)/loopback-only behavior unchanged. A new public `GET /oauth/client-info` endpoint exposes a client's non-secret metadata (`clientId` / `name` / `firstParty` / `trusted`), and the web `/oauth/authorize` consent screen uses it to auto-approve trusted clients (skipping the consent card) while leaving the flow for every other client, including `crowi-cli`, exactly as it was.
