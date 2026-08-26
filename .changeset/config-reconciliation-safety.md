---
"@crowi/api": patch
---

If two initial-setup requests race and one finishes while the other's configuration write fails partway through, the finished setup's configuration is no longer deleted — the public installer stays closed and keeps reporting "already installed" instead of reopening and exposing an uninstalled-looking instance.

The running instance now serializes its config-changing writes one at a time, and each write's ordering holds all the way through its own notification and reconfiguration, not just its database write — so a different save that succeeds while an earlier save is failing and recovering is never rolled back by that recovery, and two saves landing close together can no longer have their reconfigurations finish in the wrong order.

After a configuration save fails partway through, the instance that attempted the write now reconfigures itself the same way every other instance does — publishing the change to other instances exactly as before — instead of being left running against the old configuration while its own in-memory cache has already moved on. A plugin that writes its own configuration back while reacting to that reconfiguration cannot deadlock the instance, and a normal successful save still reconfigures only once, from the admin action that made it.
