---
"@crowi/api": patch
---

When saving admin settings partially fails to persist (some keys wrote, others didn't), the running instance now reloads its configuration from the database instead of leaving stale values in memory — every replica's in-memory config stays in agreement with what's actually stored, and the write failure still surfaces to the admin as before.

If the very first setup fails to write its seed configuration to the database, the installer can be reopened instead of permanently reporting "already installed" with no way to proceed.
