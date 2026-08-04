---
'@crowi/cli': minor
---

`-p, --profile <alias>` now works either before or after the command name (`crowi login <url> --profile work` and `crowi --profile work login <url>` both work, and now show up in every subcommand's `--help`), with the command-side value winning when both are given. Added `crowi profiles use <alias>` to switch the current/default profile — an unknown alias leaves the config untouched and exits with code `4`. `crowi profiles` now also prints a stderr-only hint on how to switch the current profile; the `--json` output shape is unchanged.
