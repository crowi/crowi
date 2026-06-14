import { readFile } from 'node:fs/promises';

import { CliError, EXIT } from './http';

/**
 * Where a page body comes from on the non-interactive write commands
 * (`create` / `update`): a literal `--message`, a `--file`, or `--stdin`.
 * Exactly one source is expected; `create` additionally falls back to an
 * interactive `$EDITOR` when none is given (handled by the caller).
 */
export interface BodySourceOptions {
  /** `-m, --message <text>` — body supplied literally on the command line. */
  message?: string;
  /** `-f, --file <path>` — read the body from a local file. */
  file?: string;
  /** `--stdin` — read the body from standard input. */
  stdin?: boolean;
}

/** Read all of stdin as a UTF-8 string. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Resolve a page body from the mutually-exclusive `--message` / `--file` /
 * `--stdin` options. Returns `undefined` when none is given (so `create` can
 * fall back to `$EDITOR`); throws {@link CliError} (exit 6) when more than
 * one source is supplied or a `--file` cannot be read.
 */
export async function resolveBody(options: BodySourceOptions): Promise<string | undefined> {
  const sources = [options.message !== undefined, options.file !== undefined, options.stdin === true].filter(Boolean).length;
  if (sources > 1) {
    throw new CliError('choose only one of --message, --file, or --stdin', { exitCode: EXIT.INVALID });
  }

  if (options.message !== undefined) {
    return options.message;
  }
  if (options.file !== undefined) {
    try {
      return await readFile(options.file, 'utf8');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new CliError(`cannot read --file ${options.file}: ${reason}`, { exitCode: EXIT.INVALID });
    }
  }
  if (options.stdin) {
    return readStdin();
  }
  return undefined;
}
