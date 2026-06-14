import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CliError, EXIT } from './http';

/**
 * Resolve which editor binary to launch for `crowi edit`. Precedence:
 * an explicit `--editor` flag, then `$VISUAL`, then `$EDITOR`. Falls back to
 * a sensible default (`vi`) when nothing is configured, so the command still
 * works on a bare shell.
 */
export function resolveEditor(explicit?: string): string {
  return explicit?.trim() || process.env.VISUAL?.trim() || process.env.EDITOR?.trim() || 'vi';
}

/**
 * Open `initial` content in the user's editor and return the edited result.
 *
 * Writes a temporary `*.md` file (so editors apply markdown syntax),
 * launches the editor inheriting the terminal's stdio, and on a clean exit
 * reads the file back. The temp file is always removed. A non-zero editor
 * exit (e.g. `:cq` in vim) aborts the edit with {@link CliError}.
 */
export async function editInEditor(initial: string, editorBin: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'crowi-edit-'));
  const file = join(dir, 'page.md');
  try {
    await writeFile(file, initial, 'utf8');
    await runEditor(editorBin, file);
    return await readFile(file, 'utf8');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Spawn the editor against `file`, inheriting stdio so an interactive
 * terminal editor (vim/nano/…) takes over the TTY. The editor command may
 * carry arguments (e.g. `code --wait`), split on whitespace. Resolves on
 * exit 0; rejects on a non-zero exit or a spawn failure.
 */
function runEditor(editorBin: string, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = editorBin.split(/\s+/).filter(Boolean);
    if (!bin) {
      reject(new CliError('no editor configured — set $EDITOR or pass --editor', { exitCode: EXIT.INVALID }));
      return;
    }
    const child = spawn(bin, [...args, file], { stdio: 'inherit' });
    child.on('error', (err) => {
      reject(new CliError(`failed to launch editor "${bin}": ${err.message}`, { exitCode: EXIT.GENERAL }));
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new CliError(`editor exited with status ${code ?? 'unknown'} — aborting edit`, { exitCode: EXIT.GENERAL }));
      }
    });
  });
}
