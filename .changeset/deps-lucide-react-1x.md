---
"@crowi/web": patch
"@crowi/site": patch
---

Bump `lucide-react` to 1.x and move it into the pnpm workspace catalog so `@crowi/web` and `@crowi/site` always share one version. lucide 1.x dropped brand-logo icons; the GitHub mark on the public site's home page is now an inlined official GitHub SVG mark instead of lucide's `GithubIcon`. All other icons keep their existing names and only pick up 1.x's minor line-drawing refinements.
