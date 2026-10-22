---
'@crowi/web': minor
---

Restructure the admin sidebar into clearer sections. User management now sits
directly under Settings, followed by a new "Shared services" position, then
Storage / Mail / Notifications. Two new sections were added: "Search" (holds
the search index page and search-backend plugins such as Elasticsearch) and
"Renderers" (holds renderer plugins such as PlantUML). The Authentication entry
moved into the Settings section (just under Security), and the Backlinks entry
was removed from the admin UI (rebuilding backlinks is now an `crowi-admin` CLI
operation). Plugins are auto-placed by their registered hook: `registerSearch`
→ Search, `registerRenderer` → Renderers.
