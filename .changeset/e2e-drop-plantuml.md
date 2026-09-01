---
"@crowi/plugin-renderer-plantuml": patch
---

The encoder is now verified against a value PlantUML itself publishes as a text-encoding example, instead of relying on a real PlantUML server round trip in the e2e suite (which required a container the local dev compose stack no longer provides, making `pnpm e2e` unrunnable locally). The plugin continues to ship as before; this only changes how its diagram-encoding correctness is verified. Registry / cache / stale-if-error behavior is still covered with a mocked renderer, unchanged.
