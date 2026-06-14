#!/usr/bin/env node
import { createProgram } from './cli';
import { CliError } from './lib/http';

createProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    // commander throws on parse errors and on `--help` / `--version`
    // (which exit 0 internally); any error reaching here is a real
    // failure. CliError carries a tailored exit code (auth / not-found /
    // conflict / …); everything else exits 1.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`crowi: ${message}\n`);
    const exitCode = err instanceof CliError ? err.exitCode : 1;
    process.exit(exitCode);
  });
