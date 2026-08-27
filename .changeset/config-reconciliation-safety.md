---
"@crowi/api": patch
---

If two initial-setup requests race and one finishes while the other's configuration write fails partway through, the finished setup's configuration is no longer deleted — the public installer stays closed and keeps reporting "already installed" instead of reopening and exposing an uninstalled-looking instance.

When a configuration save fails partway through, the running instance now serializes its config-changing writes so a different save that succeeds in the same window is never rolled back by the failed save's own recovery reload, and the ordering holds all the way through that failed save's own reconfiguration, not just its database write.

After a configuration save fails partway through, the instance that attempted the write now reconfigures itself the same way every other instance does — publishing the change to other instances exactly as before — instead of being left running against the old configuration while its own in-memory cache has already moved on. A plugin that writes its own configuration back while reacting to that reconfiguration cannot deadlock the instance, and a normal successful save still reconfigures only once, from the admin action that made it.
