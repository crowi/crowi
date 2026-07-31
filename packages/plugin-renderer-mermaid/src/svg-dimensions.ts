/**
 * RFC-0023 — `extractSvgDimensions` moved to `@crowi/svg-sanitize`
 * (`src/dimensions.ts` there, full rationale in its doc comment) so
 * PlantUML's SVG sidecar path can share the same `viewBox` derivation.
 * Re-exported here so this package's internal imports (`index.ts`) and
 * its unit test keep their original module path.
 */
export { extractSvgDimensions } from '@crowi/plugin-api';
