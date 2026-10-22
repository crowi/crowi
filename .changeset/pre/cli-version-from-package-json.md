---
'@crowi/cli': patch
---

`crowi --version` now reports the version you actually have installed. It printed a hardcoded `0.1.0-dev` — the string the package was scaffolded with — for every release since, so the one command you run to answer "what version are you on?" could not answer it.
