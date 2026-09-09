/**
 * Minimal HTML artifact fixtures shared by `artifact/ingest.test.ts` and by
 * later leaves (`feature-html-artifact-delivery-policy`'s `csp.test.ts`,
 * `feature-html-artifact-write-path`'s `page.test.ts`). Lives outside any
 * `*.test.ts` file because two test files importing from each other would
 * register each other's `describe` blocks twice.
 */

/**
 * Builds a document that passes every rule in `ARTIFACT_INGEST_RULES`:
 * one inline `<script>`, one inline `<style>`, a `charset` meta, and a
 * single body element. Callers override the script/style/body source to
 * exercise specific behaviour while keeping everything else valid.
 */
export function validArtifactHtml(options?: Readonly<{ script?: string; style?: string; body?: string }>): string {
  const script = options?.script ?? "console.log('crowi-artifact-fixture');";
  const style = options?.style ?? 'body { color: rebeccapurple; }';
  const body = options?.body ?? '<p>hello from the artifact fixture</p>';
  return (
    '<!doctype html>\n' +
    '<html>\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    `<style>${style}</style>\n` +
    `<script>${script}</script>\n` +
    '</head>\n' +
    '<body>\n' +
    `${body}\n` +
    '</body>\n' +
    '</html>\n'
  );
}

export const VALID_ARTIFACT_HTML = validArtifactHtml();
