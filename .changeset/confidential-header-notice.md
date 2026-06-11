---
'@crowi/api-contract': minor
---

Surface the confidentiality notice (`app:confidential`) in the app header. The
public `GET /app/info` response now includes a `confidential` field, and the
authenticated web shell renders the operator-set text as an always-on marker:
a compact muted-amber label in the header's right cluster on desktop (which
yields while the global search box is focused so the search can expand), and a
thin centered line directly under the header on mobile where the right cluster
has no room. The notice is hidden entirely when unset. This makes screenshots
and printouts visibly carry the confidentiality marker, satisfying corporate
IT requirements.
