# ADR 0002 — Keep the Redis licence question out of the operations docs

- **Status**: Accepted
- **Date**: 2026-09-07
- **Deciders**: Crowi maintainers
- **Related**: [operations/redis](../../apps/crowi-site/content/docs/en/operations/redis.mdx)

## Context

Redis Open Source 8.0 offers a choice of three licences (RSALv2, SSPLv1, AGPLv3), only the last of which is OSI-approved, and the operations docs carried roughly 13,000 characters recording that fact, the project's reading of it, a non-legal-advice framing, and triggers for re-reviewing the position. Crowi does not bundle, modify, sublicense or redistribute Redis: the api opens a network connection to an unmodified upstream server the operator runs, exactly as any application using a database does, so an operator has no decision to make on the basis of that material.

## Decision

The licence material is not carried on the documentation site. The Redis operations page keeps only what an operator acts on — tested version range, the advice to pin an image, the status of Valkey, the prohibition on split-brain, clearing stale coordination state, connection-count estimates — plus one sentence stating that choosing a managed Redis service and complying with its terms is the operating organisation's responsibility. Valkey stays best-effort rather than supported until the compatibility suite that gates Redis 8 runs against it continuously in CI; that is the criterion, and the licence is not.

## Consequences

If Crowi ever forks, modifies, mirrors or bundles Redis, or exposes it to end users as a service, this decision no longer holds and the question has to be answered properly rather than declared out of scope.
