import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { editInEditor } from './editor';

/**
 * `editInEditor` spawns the real `editorBin` — these tests point it at a
 * tiny Node script (rather than mocking `child_process.spawn`) so the whole
 * spawn → wait-for-exit → read-back path runs for real. The fake editor
 * records the basename of the file it was asked to open (RFC-0020 §E —
 * temp-file extension selection) into a side-channel capture file, then
 * exits 0 without modifying the file's content.
 *
 * The capture file's path is embedded directly in the generated script
 * (a string literal), NOT passed via `process.env` — ts-jest does not
 * reliably propagate the parent process's env into a spawned child in this
 * harness, so an env-var handoff here would silently read back `undefined`.
 */
describe('editInEditor — temp file extension (RFC-0020 §E)', () => {
  let scratchDir: string;
  let scriptPath: string;
  let captureFile: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'crowi-cli-editor-test-'));
    captureFile = join(scratchDir, 'captured-basename.txt');
    scriptPath = join(scratchDir, 'fake-editor.cjs');
    writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        `fs.writeFileSync(${JSON.stringify(captureFile)}, path.basename(process.argv[2]));`,
      ].join('\n'),
    );
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('defaults to a page.md temp file when no extension argument is given', async () => {
    await editInEditor('# hello', `node ${scriptPath}`);
    expect(readFileSync(captureFile, 'utf8')).toBe('page.md');
  });

  it('uses a page.md temp file when the extension argument is explicitly "md"', async () => {
    await editInEditor('# hello', `node ${scriptPath}`, 'md');
    expect(readFileSync(captureFile, 'utf8')).toBe('page.md');
  });

  it('uses a page.html temp file when the extension argument is "html" (artifact pages)', async () => {
    await editInEditor('<html></html>', `node ${scriptPath}`, 'html');
    expect(readFileSync(captureFile, 'utf8')).toBe('page.html');
  });

  it('still returns the (unedited) file content regardless of extension', async () => {
    const result = await editInEditor('<html>unchanged</html>', `node ${scriptPath}`, 'html');
    expect(result).toBe('<html>unchanged</html>');
  });
});
