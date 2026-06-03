---
'@crowi/api': minor
---

Drop the legacy AWS config migration and the core `upload:aws:*` settings.
Third-party credentials (AWS for S3 storage / SES mail, SMTP password, etc.)
now live exclusively in their plugin's config namespace
(`crowi:plugin:<name>:<field>`, encrypted via the plugin's `@sensitive`
fields). The boot-time copy of legacy `upload:aws:*` into the plugin namespace,
the `aws:*` → `upload:aws:*` rename, and the `upload:aws:*` install defaults
were removed, along with their entries in the encrypt-at-rest registry.

Operator impact: when upgrading from old Crowi, AWS/S3 credentials are no
longer migrated automatically. Enable `@crowi/plugin-aws` (and
`@crowi/plugin-storage-aws-s3`) and re-enter the credentials in the admin
Plugins screen; they are stored in the plugin namespace and encrypted. OAuth
(Google / GitHub) secrets remain in core config until auth providers become
plugins.
