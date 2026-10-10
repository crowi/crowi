---
"@crowi/plugin-mail-smtp": patch
"@crowi/api": patch
---

Update the dependency `nodemailer` to 10.0.13, which fixes a malformed SMTP envelope recipient produced from an address whose local part is quoted. Crowi hands it the recipient addresses of the mail it sends, such as user invitations and notifications.
