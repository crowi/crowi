#!/usr/bin/env node
import { createProgram } from './cli';

createProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    // commander throws on parse errors and on `--help` / `--version`
    // (which exits 0 internally); any error reaching here is a real
    // failure. Log + exit with a non-zero code so shell scripts can
    // detect it.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`crowi-admin: ${message}`);
    process.exit(1);
  });
