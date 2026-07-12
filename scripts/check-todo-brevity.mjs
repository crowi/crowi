#!/usr/bin/env node
// Structural guard for TODO.md's own rule: 「実装詳細・経緯は書かない(肥大化防止)
// / 各項目は原則 1 行」。The prose rule alone was violated repeatedly (16 bullets
// grew past 300-1100 chars by 2026-07-12), so this check makes it mechanical:
// any `- ` bullet line longer than MAX_BULLET_CHARS fails. Details belong in
// the spec (`.feature-state/specs/`), git log, or the changeset — a TODO entry
// is a name, one sentence, and a pointer.
//
// Wired into lefthook pre-commit (when TODO.md is staged) and run by
// integrate-worktree Step 4 so worktree-authored docs(todo) commits cannot
// land bloated entries through the merge chokepoint either.
import { readFileSync } from 'node:fs';

const MAX_BULLET_CHARS = 300;
const path = new URL('../TODO.md', import.meta.url);
const lines = readFileSync(path, 'utf8').split('\n');

const violations = lines
  .map((text, i) => ({ text, line: i + 1 }))
  .filter(({ text }) => /^- /.test(text) && text.length > MAX_BULLET_CHARS);

if (violations.length > 0) {
  console.error(`TODO.md brevity check failed: ${violations.length} bullet(s) exceed ${MAX_BULLET_CHARS} chars.`);
  console.error('TODO.md is for orientation only — move the detail into the spec / commit message and keep');
  console.error('the entry to: `- **<name>** — <one sentence>(spec: `<file>`)`.');
  for (const v of violations) {
    console.error(`  L${v.line} (${v.text.length} chars): ${v.text.slice(0, 80)}...`);
  }
  process.exit(1);
}
