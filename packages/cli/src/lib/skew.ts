import type { Command } from 'commander';

/**
 * Opt-out registry for the per-invocation version-skew probe.
 *
 * The `preSubcommand` hook (see `cli.ts`) runs {@link maybeWarnVersionSkew}
 * before every authenticated command so the skew note is live for the whole
 * Phase 1 surface. A few commands must NOT trigger it: local-only ones with no
 * wiki API call (`open`, `completion`) and pre-auth ones that may have no
 * usable token yet (`login`, `logout`, `profiles`).
 *
 * Tying the opt-out to the actual `Command` object (via a typed `WeakSet`)
 * instead of a hand-maintained name set means a newly-added command defaults
 * to "probe" — it can never silently inherit the wrong behavior by omission,
 * and a renamed command keeps its opt-out without a string going stale.
 */
const noSkewProbe = new WeakSet<Command>();

/** Mark a command (and its subcommand group root) as exempt from the probe. */
export function markNoSkewProbe(command: Command): Command {
  noSkewProbe.add(command);
  return command;
}

/** Whether the given subcommand opted out of the version-skew probe. */
export function isNoSkewProbe(command: Command): boolean {
  return noSkewProbe.has(command);
}
