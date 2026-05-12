/**
 * Typed wrapper around the untyped `plantuml-encoder` npm package
 * (no `@types/plantuml-encoder` exists on DefinitelyTyped). The package
 * exports a single CJS function `{ encode(source: string): string }`
 * that deflate-encodes the diagram source and re-encodes with PlantUML's
 * custom base64-ish alphabet (`{ 0..9, A..Z, a..z, -, _ }`).
 *
 * We re-export `encode` so the rest of the plugin code can rely on a
 * single typed surface instead of casting at every call site.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const plantumlEncoder = require('plantuml-encoder') as { encode(source: string): string };

/**
 * Encode a PlantUML diagram source into the URL-safe token the
 * PlantUML server reads from `/${format}/${encoded}`.
 *
 * Example:
 *   encode('@startuml\nA -> B\n@enduml')
 *   // → 'SoWkIImgAStDuNBAJrBGjLDmpCbCJbMmKiX8pSd9vt98pKi1IW00'
 */
export function encode(source: string): string {
  return plantumlEncoder.encode(source);
}
