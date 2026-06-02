---
'@crowi/plugin-api': minor
'@crowi/api': minor
---

Plugins can now localize their admin config-form field labels and descriptions.
A plugin declares a `configI18n` catalog (`locale → field → { label, description }`)
and the admin API overlays the entry matching the requesting admin's locale on
top of the schema-derived field; the Zod `.describe()` text remains the default
when a translation is missing. The `GET /admin/plugins/config` endpoint accepts
an optional `locale` query parameter, and `PluginField` gained an optional
`label`. The PlantUML renderer ships Japanese translations for its server URL
and image format fields as the first consumer.
