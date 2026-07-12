# crowi-pr-received response templates

Base texts for Phase 3 drafts. Always adapt to the specific PR (mention concrete
files / points you appreciated); never post verbatim without adjusting. Tone:
grateful, direct about the reason, and — wherever honest — leave the door open.

## conditional-accept-locale

> Thanks for taking the time to translate Crowi into <language>!
>
> Adding a new UI locale is a long-term commitment for the project rather than a
> one-time diff: every future feature adds new message keys, and a locale
> without an active maintainer falls behind quickly — which ends up being a
> worse experience than the English fallback. Since none of the current
> maintainers can review <language> text, we'd like to ask two things before
> deciding:
>
> 1. Are you (or your team) actually using Crowi? We'd love to hear about the
>    use case.
> 2. Would you be willing to keep the <language> locale up to date as new
>    strings land (roughly: respond to a ping when a release adds keys)?
>
> If both are a yes, we're happy to move forward with review. If we don't hear
> back in a couple of weeks we'll close this for now — with no hard feelings,
> and we'd welcome it again once there's demand and a maintainer for the locale.

## close-spam

> Thanks for the PR. We're closing it because it doesn't address a need raised
> by Crowi users or an issue in this repository. If you're actually using Crowi
> and ran into something concrete, please open an issue describing it first —
> we're glad to discuss real use cases.

## close-deps

> Thanks, but we manage dependency upgrades internally (with our own review and
> release cadence), so we don't take version-bump PRs. Closing. If you found an
> actual incompatibility or vulnerability, please open an issue (or use private
> security reporting — see SECURITY.md) describing the impact instead.

## close-feature

> Thanks for the proposal — we appreciate the thought that went into it.
> After consideration, this isn't a direction we want to take Crowi's core
> right now (<one-line reason>). We're noting the underlying need as a feature
> request for future planning. For feature-sized changes, please open an issue
> first so we can align on the approach before any implementation work.

## close-bugfix-alternative

> Thanks for the report and the fix! We confirmed the underlying issue is real.
> We're addressing it with a different approach (<one-line why — e.g. the root
> cause is one layer deeper>), so we'll close this PR, but your report is what
> surfaced it — we'll reference this PR in the fix. (<credit/authorship note if
> any of the code is reused>)

## security-redirect

> Thanks for looking into Crowi's security. Please don't post potential
> vulnerabilities or their fixes as public PRs — that discloses the issue
> before a fix ships. Use GitHub's private vulnerability reporting (Security →
> "Report a vulnerability") as described in SECURITY.md, and we'll follow up
> there and credit you in the fix. Closing this PR to limit exposure.
