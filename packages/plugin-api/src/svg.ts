/**
 * SVG sanitization, re-exported for plugins.
 *
 * The implementation lives in `@crowi/svg-sanitize`, a private workspace
 * package that is never published: it is a shared util, not a renderer plugin,
 * and a package under `@crowi/` would read as one. It is inlined into this
 * SDK's `dist` at build time (`noExternal` in `tsup.config.ts`), so the
 * published tarball carries the code rather than a dependency on a package
 * that does not exist on npm.
 *
 * This module is the ONE place that inlining happens. Core (`@crowi/api`) and
 * the bundled renderer plugins all reach the sanitizer through here, which is
 * both what makes core able to use it at all — core builds with `tsc` and
 * cannot inline a private workspace package itself — and what keeps a single
 * copy in circulation instead of one per consumer.
 *
 * `@xmldom/xmldom`, which the sanitizer needs for `DOMParser` /
 * `XMLSerializer`, is deliberately NOT inlined: it stays a declared runtime
 * dependency of this package so an operator can address a CVE in it through
 * their own lockfile or overrides without waiting on a Crowi release.
 */
export { extractSvgDimensions, sanitizeSvg } from '@crowi/svg-sanitize';
export type { SanitizeSvgPolicy, SanitizeSvgResult } from '@crowi/svg-sanitize';
