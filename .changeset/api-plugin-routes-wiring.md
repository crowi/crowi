---
"@crowi/api": minor
---

Wire plugin-contributed HTTP routes into the Hono app: PluginManager registers each plugin's `registerRoutes(scope, ctx)` surface during boot (public + raw body), so plugins such as `@crowi/plugin-slack` can mount their own endpoints. Also fix the plugin dependency-cycle error to report only the actual cycle rather than the acyclic prefix that led into it.
