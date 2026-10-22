---
"@crowi/plugin-mail-smtp": patch
---

Bump `nodemailer` to `^9.0.1` to clear two high-severity Dependabot advisories. The `createTransport` / `sendMail` surface the SMTP sender uses is unchanged across the 8 → 9 major (verified by type-check, build, and a `jsonTransport` runtime smoke). nodemailer 9 requires Node 20+, which Crowi already mandates.
