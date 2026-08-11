---
"@crowi/api": patch
"@crowi/admin-cli": minor
---

Add the durable data model, page-local ordering, and repair machinery for page history (RFC-0021), Phase 1 of the rollout. This adds new `PageHistoryEvent` and `PageHistoryOperation` collections, additive `historySequence` / `historyTracking` / `pendingHistoryEntry` fields on `Page`, and additive `historySequence` / `historyOperationId` fields on `Revision`, plus an idempotent materializer and repair job for the new outbox. No writer produces a `PageHistoryEvent` yet and no HTTP route changes — every existing page keeps recording history exactly as it does today; only newly created pages are marked ready for the writers that later phases will add. Comment creation now re-validates the owning page immediately after insert and removes the comment if the page was trashed or renamed in the meantime, closing a narrow authorize-then-insert race. Adds `crowi-admin page-history repair` (`--outbox` / `--scan`), the operator entry point for draining a crashed writer's leftover outbox entry and, on request, assigning sequences to unsequenced Revisions on already-ready Pages.
