---
'@crowi/plugin-slack': patch
---

Update `follow-redirects`, which the Slack client's HTTP layer uses, to 1.16.1. Vulnerabilities had been reported in the 1.16.0 release where credentials could survive a redirect to another origin.
