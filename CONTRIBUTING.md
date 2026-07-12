# Contributing to Crowi

Thanks for your interest in Crowi! This document explains what kinds of
contributions we can accept and how to make yours land smoothly. Crowi 2.0 is
currently developed by a small maintainer team with a high review bar, so
please read this before opening a PR.

## Before you open a PR

- **Open an issue first for anything feature-sized.** Whether a feature
  belongs in Crowi's core is a product decision; agreeing on the direction
  before you write code saves everyone's time. PRs for undiscussed features
  may be closed with the need noted as a feature request.
- **Bug fixes are welcome.** Describe the reproduction and the root cause in
  the PR body. We verify the diagnosis against the code before merging, and we
  care that a fix addresses the root cause rather than hiding a symptom.
- **Small docs/typo fixes** can be sent directly.

## What we don't take as PRs

- **Dependency version bumps** (`package.json` / `pnpm-lock.yaml`). We manage
  upgrades internally with our own review and release cadence. If you found a
  real incompatibility or vulnerability, open an issue describing the impact
  instead.
- **CI workflow changes** (`.github/workflows/`). For security reasons we
  never merge externally-authored workflow changes; propose the idea in an
  issue and we'll implement it ourselves.
- **Security fixes as public PRs.** A public PR discloses the vulnerability
  before a fix ships. Use private vulnerability reporting instead — see
  [SECURITY.md](SECURITY.md). You'll be credited in the fix.

## Adding a new UI language

A new locale is a long-term commitment, not a one-time diff: every future
feature adds message keys, and a locale without an active maintainer falls
behind quickly. We accept new-locale PRs when both of these hold:

1. There's real demand — you or your team actually use Crowi in that language.
2. You're willing to act as the locale's maintainer and keep it up to date as
   new strings land.

Translation updates for existing locales (`packages/web/messages/`) are
welcome anytime.

## Review process and expectations

- Maintainers review the full diff before running any code from a PR (supply
  chain hygiene), so even small PRs may take a few days.
- We aim to respond to every PR within a week.
- We may close a PR while adopting its underlying idea; when we reuse your
  code we preserve your authorship (merge or cherry-pick), and when we
  reimplement we credit the PR in the commit.

## Community

If you're interested in contributing on an ongoing basis — or just want to
talk to the dev team — join the Crowi Discord community:
https://discord.gg/jnWzJeu . It's the best place to discuss ideas before they
become issues or PRs.

## Development basics

See [CLAUDE.md](CLAUDE.md) and [README](README.md) for the monorepo layout and
dev commands. In short: `docker compose up -d` for infra, `pnpm dev` for
api+web, `pnpm test` / `pnpm lint` must be green, commit messages follow
Conventional Commits in English.
