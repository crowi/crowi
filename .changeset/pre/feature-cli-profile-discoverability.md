---
'@crowi/cli': minor
---

The global flags (`-p, --profile <alias>`, `--url`, `--token`, `--json`, `-q`) now appear in every subcommand's `--help` under a "Global Options" heading, so `crowi login --help` finally tells you `--profile` exists. The flags themselves are unchanged: they have always been accepted either before or after the command name (`crowi login <url> --profile work` and `crowi --profile work login <url>` both work), with the later occurrence winning when given on both sides. Added `crowi profiles use <alias>` to switch the current/default profile — an unknown alias leaves the config untouched and exits with code `4`. `crowi profiles` now also prints a stderr-only hint on how to switch the current profile; the `--json` output shape is unchanged.
