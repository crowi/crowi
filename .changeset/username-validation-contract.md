---
"@crowi/api": patch
"@crowi/api-contract": patch
---

Enforce a single, shared username validation contract across self-registration, invite acceptance, and first-admin (installer) creation.

Username input is now restricted to ASCII letters, digits, `_`, and `-`, 1-64 characters, matching what the `@mention` renderer already recognizes. Previously each of the three account-creation forms validated username with a different (and looser) rule, and the `User` model itself did not validate the field at all — so an empty, whitespace-only, or otherwise malformed username could reach the database and break the `/user/<username>` page namespace. Non-conforming values are now rejected with the existing `400 VALIDATION_ERROR` response before any account is created or activated. Installer account creation, which previously also allowed `.` in usernames, now uses the same rule as the other two forms. Existing usernames already stored in the database are left untouched — this only applies to new or changed usernames.
