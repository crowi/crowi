#!/usr/bin/env node

/**
 * PreToolUse Hook for Write / Edit
 *
 * Blocks direct Write/Edit on the crowi-feature pipeline's state files:
 *   - .feature-state/tasks/<id>.json (including the *.json.tmp and *.json.bak forms)
 *   - .feature-state/queue.json (including the .tmp and .bak forms)
 *
 * .bak is included because it is the recovery copy task-state.sh's atomic
 * write path relies on — an agent overwriting it directly (even with
 * well-intentioned content) would defeat the "cp .bak back to restore"
 * recovery procedure documented in `task-state.sh --help`.
 *
 * All mutation of these files must go through `.claude/scripts/task-state.sh`,
 * which validates structural invariants and writes atomically with a .bak
 * backup. Two real incidents (a 0-byte truncation, and a silent structural
 * rewrite that flipped phases[].autoContinue from false to true, defeating a
 * human gate) came from agents Reading the whole JSON, regenerating it, and
 * Writing it back — see .feature-state/specs/feature-task-state-script.md.
 *
 * Read is NOT affected (this hook's matcher is Write/Edit only).
 */

const path = require('node:path');

const TASKS_RE = /(^|\/)\.feature-state\/tasks\/[^/]+\.json(\.tmp|\.bak)?$/;
const QUEUE_RE = /(^|\/)\.feature-state\/queue\.json(\.tmp|\.bak)?$/;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const hookInput = JSON.parse(input);
    const rawPath = hookInput.tool_input?.file_path || '';
    // Collapse ".."/"." segments BEFORE regex matching — otherwise a path
    // like ".feature-state/tasks/../queue.json" resolves (at the filesystem
    // level) to the protected queue.json while matching neither regex as
    // written, silently bypassing the block this hook exists to enforce.
    const filePath = path.normalize(rawPath).split(path.sep).join('/');

    if (TASKS_RE.test(filePath) || QUEUE_RE.test(filePath)) {
      console.error(JSON.stringify({
        decision: 'block',
        reason:
          `Direct Write/Edit to crowi-feature pipeline state (${filePath}) is disabled. ` +
          'Use `.claude/scripts/task-state.sh` instead (run `.claude/scripts/task-state.sh --help` ' +
          'for the full subcommand list and the recovery procedure). Direct Write/Edit of this file ' +
          'caused real corruption incidents in the past (0-byte truncation, and a silent structural ' +
          'rewrite that flipped a phases[].autoContinue human gate from false to true) — this hook ' +
          'exists to make that failure mode structurally impossible. Reading the file is unaffected.',
      }));
      process.exit(2);
    }

    process.exit(0);
  } catch (error) {
    // Fail open on unexpected/unparseable hook input, matching validate-bash.js's convention.
    process.exit(0);
  }
});
