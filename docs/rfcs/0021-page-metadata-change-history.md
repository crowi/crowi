# RFC-0021: Page history for non-content changes

- **Status**: Draft
- **Author**: @sotarok
- **Created**: 2026-07-29
- **Depends on**:
  - RFC-0003 (Realtime Collaborative Editing) — collaborative saves persist a
    Revision before conditionally advancing the Page pointer. This RFC extends
    that compare-and-set boundary with page-local history ordering without
    changing the Yjs document or collaboration protocol.
  - RFC-0008 (Migration Framework) — existing content revisions require a
    resumable page-local sequence backfill before the merged timeline becomes
    authoritative.
  - RFC-0009 (Revision Storage Compaction) — `Revision.type`,
    `parentRevisionId`, `body`, `yjsUpdate`, and snapshot/incremental
    reconstruction remain content-storage concepts. Page metadata events never
    enter that reconstruction chain.
  - RFC-0018 (Revision-aware Quoted Page Comments) — a Revision remains an
    immutable content snapshot and the only valid quoted-comment source.
- **Related**:
  - RFC-0017 (Live Collab Editor Invalidation) — rename, trash, restore, and
    direct body replacement already advance `collabLifecycleVersion` in the
    same Page write as the lifecycle mutation
    (`packages/api/src/models/page.ts:1554-1563,1752-1827,1947-1995`).
  - The current Revision model stores required `body` and inline
    `renderedAst`, while `type` is already the snapshot/incremental storage
    discriminator (`packages/api/src/models/revision.ts:168-179,245-294`).
  - Page grants, content saves, trash/restore, hard delete, and rename currently
    follow different write paths (`packages/api/src/models/page.ts:1565-1621,1670-1867,1947-2111`).
  - The current history UI treats every row as a content revision and offers
    from/to diff controls for every row
    (`packages/web/src/components/page-history/page-history.tsx:46-115,160-283`).

## §0 Summary

Crowi will record page creation, rename, visibility, trash, restore, and
publish as typed, append-only `PageHistoryEvent` documents. Hard deletion is
recorded separately, keyed by path rather than by Page, as a gated Phase-4
addition. Content
versions remain `Revision` documents. A new server-side history endpoint will
merge both sources into one cursor-paginated, page-local timeline represented
as a discriminated union.

`Revision` remains a content-only model. In particular, `body` stays required,
`renderedAst` stays attached to content snapshots, and `Revision.type` remains
`snapshot | incremental`. Crowi will not create dummy or metadata-only
Revision rows.

Every committed history entry receives a monotonic `historySequence` from the
owning Page. Sequence assignment occurs in the same atomic Page
compare-and-set as the state or revision-pointer change. A single bounded
outbox slot on the Page then materializes either the metadata event or the
sequence assignment to its cross-collection target. The slot is always empty
or contains exactly one pending write. Deterministic identifiers and
idempotent upserts make request retries, crash recovery, and background repair
safe on standalone MongoDB.

This outbox is required in the first release. A best-effort dual write is not
an acceptable intermediate state: previous paths, previous grants, actors, and
operation boundaries are not retained anywhere else, so an event missed during
a best-effort period could never be reconstructed.

Content restore remains body-only. A rename, visibility change, trash, or
restore is reversed only by executing the corresponding domain operation
again after checking the current state. The inverse operation creates a new
history event; it never edits the earlier event.

Phase 4 hard delete purges content revisions and ordinary page-local history,
and writes a minimal administrator-only `PageDeletionRecord` keyed by the path
the Page occupied. That record is retained indefinitely — a path can be reused,
so a Page-keyed or expiring record would lose the answer exactly when it is
asked. Deployments whose privacy policy requires erasure remove records through
an explicit administrative operation.

**Scope discipline.** This RFC changes where changes are recorded. It does not
change who may make them, how often they may be made, or what a page path may
contain. The one deliberate product-visible change outside recording is that
path-reserving commands begin requiring a client-generated idempotency key
(§8.1), which is what makes their retries recoverable at all.

**Two limits of standalone MongoDB are stated rather than designed away.** A
path is briefly unoccupied while a Page moves off it, because two Pages can
never hold one path (§6.2a); and a replica running a release that predates the
tracking predicate cannot be fenced by that predicate during the sequence
backfill (§13.2a). Both are handled by making the residual condition detectable
and repairable, not by asserting an atomicity the deployment does not provide.

## §1 Background and motivation

Crowi currently has durable content history but not durable page-state history.
A Revision contains the Markdown body, render metadata, rendered AST,
collaboration storage fields, author, and creation time. The save factory
always accepts a body and runs the renderer
(`packages/api/src/models/revision.ts:364-405`). This is a content snapshot,
not a generic audit row.

Metadata and lifecycle operations leave inconsistent traces:

- a body save creates a Revision and updates `lastUpdateUser` and `updatedAt`;
- a grant-only update mutates `grant` and `grantedUsers` with `page.save()` but
  creates no Revision or Activity and does not explicitly update
  `lastUpdateUser` or `updatedAt`
  (`packages/api/src/models/page.ts:1565-1582`);
- a rename atomically changes Page path and lifecycle epoch, then
  best-effort rewrites every historical `Revision.path`; it creates no content
  Revision (`packages/api/src/models/page.ts:1947-1995`);
- trash and restore are status changes plus internal renames, but neither
  creates a durable lifecycle record
  (`packages/api/src/models/page.ts:1752-1827`);
- hard delete removes the Page, its Revisions, Comments, Attachments,
  Bookmarks, and Activities (`packages/api/src/models/page.ts:1833-1904`);
- draft publication is visible only as an ordinary content save and status
  change; and
- content restore creates a new Revision from an old body while deliberately
  preserving the current grant (`packages/api/src/hono/handlers/page.ts:958-1011`).

The in-process `pageEvent` emitter does not fill this gap. It is a best-effort
side-effect dispatcher. UPDATE Activity creation runs only when
`revisionCreated === true`, and failures are swallowed so notification failure
does not fail a content save (`packages/api/src/events/page.ts:35-46,103-133`).
Soft delete does not emit the trashed Page through this event path
(`packages/api/src/events/page.ts:49-58`).

`Activity` is also unsuitable as the durable source. Its schema has no
before/after state and contains a source TODO for the revision id
(`packages/api/src/models/activity.ts:40-75`). Unlike removes LIKE Activity,
comment deletion removes COMMENT Activity, and hard page deletion calls
`Activity.removeByPage` (`packages/api/src/models/activity.ts:90-160,213-219`;
`packages/api/src/models/page.ts:1861-1864`). CREATE, MODIFY, and DELETE remain
unsupported action constants
(`packages/api/src/util/activity-define.ts:4-37`).

The result is an irreversible information gap. After a rename, all
denormalized Revision paths may show the new path. After a grant change, only
the current grant exists. For grant-only changes there is not even a reliable
timestamp or actor fallback. A later migration cannot infer the missing facts
without fabricating history.

## §2 Goals and non-goals

### §2.1 Goals

- Preserve `Revision` as the content-version authority.
- Record page creation, rename, visibility category, trash, restore, and
  publish with typed before/after payloads; add hard-deletion payloads only in
  the Phase-4 protocol.
- Give all content and metadata entries a page-local monotonic sequence.
- Exclude collaborative CAS-loser Revisions from the displayed timeline for
  writes committed after cutover. Pre-cutover content history retains its
  current `Revision.page` list semantics because no reliable historical winner
  marker exists.
- Make the metadata state change and its recoverable history write atomic on
  standalone MongoDB.
- Return one server-merged, cursor-paginated history timeline.
- Keep content diff and body restore limited to content revisions.
- Group subtree rename events with an opaque, server-generated
  `operationId`.
- Preserve current Page authorization and minimize event payloads so a later
  restricted-to-public transition does not disclose ACL membership.
- Define the hard-delete deletion record and explicit-erasure protocol for the
  Phase-4 release, rather than expose partial deletion history earlier.
- Route search, backlink, cache, presence, Activity, and Notification effects
  by explicit committed entry kind.
- Make grant-only changes update `lastUpdateUser` and `updatedAt`.

### §2.2 Non-goals

- A tenant-wide compliance or security audit UI.
- Recording comments, likes, bookmarks, watches, seen-by changes, restricted
  link claims, or attachment operations in page history.
- Storing granted-user additions/removals in ordinary page history.
- Reconstructing metadata changes that occurred before tracking starts.
- Making an entire subtree rename transactional on standalone MongoDB.
- Restoring path, grant, status, redirect pages, or ACL membership as part of
  content revision restore.
- Replacing existing Revision detail, diff, or quoted-comment endpoints.
- Treating process-local events, Activity, or Notification as history
  authorities.

## §3 Existing contracts that remain authoritative

### §3.1 Revision means content

`Revision.body` is required and `renderedAst` is stored inline as
`Schema.Types.Mixed` (`packages/api/src/models/revision.ts:170-179,245-254`).
`prepareRevision` sets the immutable Page reference, body, author, timestamp,
render metadata, and rendered AST in one content-oriented factory
(`packages/api/src/models/revision.ts:364-405`).

`Revision.type` is already the storage encoding discriminator with values
`snapshot` and `incremental`
(`packages/api/src/models/revision.ts:273-294`). It is not available for a page
event kind. RFC-0009 reconstruction, RFC-0018 quoted-comment anchoring,
backlink extraction, render caches, and content diff all continue to consume
content Revisions only.

The ordering field introduced by §5.4 is additive bookkeeping. It does not
make a Revision a page event, relax `body`, add event payload, or alter
snapshot/incremental semantics.

### §3.2 Page identity is the immutable Page id

Revision ownership is the immutable `Revision.page` id, not the mutable
`Revision.path` display string
(`packages/api/src/models/revision.ts:24-51`). Existing revision list reads
already authorize the Page and query Revisions by that id
(`packages/api/src/hono/handlers/revision.ts:113-155`).

The new endpoint follows the same rule. Past paths are data displayed after
authorization; they are never authorization keys.

### §3.3 Content restore remains body-only

The current restore handler loads a Revision belonging to the Page and stacks
its body as a new Revision. It passes no grant option, explicitly preserving
current visibility (`packages/api/src/hono/handlers/page.ts:989-1011`). This
RFC keeps that behavior.

Full-state restoration would be unsafe:

1. a body written while a page was private could become public under the
   current grant;
2. a historical path may now be occupied by another Page; and
3. a historical granted user may have left or been suspended.

Metadata reversal is therefore a new domain operation, not a property of
content restore. This is also consistent with MediaWiki's refusal to mark null
revisions as `mw-reverted`: doing so would imply that the associated move or
protection action had itself been undone.

### §3.4 Side effects are projections

Search indexing, backlinks, render-cache invalidation, presence broadcasts,
Activity, and Notification are derived effects. They may retry or fail without
rewriting durable history. Backlinks require a saved revision body and persist
`fromRevision` (`packages/api/src/models/backlink.ts:146-205`). Presence
content refresh is explicitly gated by `revisionCreated === true`
(`packages/api/src/events/presence-broadcast.ts:80-118`).

The durable event is upstream of these projections:

```text
Page command
  ├─ content save ──────────> Revision
  └─ metadata/lifecycle ────> PageHistoryEvent

Revision ────────────────┐
                        ├─> merged history endpoint ─> History UI
PageHistoryEvent ────────┘

Committed entry ─> side-effect dispatcher ─> Activity / Notification / indexes
```

## §4 Decision and domain model

Page-local history has two authorities:

| Concern | Authority | Meaning |
| --- | --- | --- |
| Content versioning | `Revision` | A saved Markdown body and its derived content artifacts |
| Metadata/lifecycle history | `PageHistoryEvent` | A typed state transition on the stable Page identity |

The user-facing history timeline is a server-side read model over both. It is
not a third write authority and it is not assembled from two client queries.

The two authorities are deliberately not symmetric, and the asymmetry is the
load-bearing idea of this design. **A content save records itself**: writing the
Revision *is* creating the history entry, so nothing further has to survive for
the save to appear in history. **A metadata change records nothing**: after a
rename the old path is overwritten, after a grant change only the current grant
remains, and neither retains an independent actor or time. The outbox (§6) exists
to give metadata the durability content already has — which is why it belongs on
the metadata path and must not be extended to the content path (§15.6).

Administrative audit is a separate future read model. A future audit pipeline
may project from committed PageHistoryEvent documents, but ordinary page
history does not gain organization-wide retention or ACL-member payloads by
implication.

## §5 Data model

### §5.1 PageHistoryEvent envelope

The conceptual event envelope is:

```ts
type PageHistoryEventKind =
  | 'page_created'
  | 'page_renamed'
  | 'visibility_changed'
  | 'page_trashed'
  | 'page_restored'
  | 'draft_published';

type PageHistoryEvent<K extends PageHistoryEventKind> = {
  _id: ObjectId;
  page: ObjectId;
  sequence: number;
  kind: K;
  actor: ObjectId | null;
  occurredAt: Date;
  operationId: string;
  source: 'web' | 'oauth' | 'pat' | 'collab' | 'system';
  payload: PageHistoryPayloadByKind[K];
};
```

Every event in this collection belongs to a Page that still exists. Hard
deletion is recorded elsewhere — see §5.6 — so there is no admin-scoped
variant here and no expiry: a page-scoped event lives exactly as long as its
Page.

`payload` is implemented as kind-specific nested schemas or Mongoose
discriminators, not `Mixed`. Raw request bodies and arbitrary metadata are
never stored.

### §5.2 Typed payloads

```ts
type PageHistoryPayloadByKind = {
  page_created: {
    path: string;
    grant: PageGrant;
    status: 'published' | 'draft';
  };
  page_renamed: {
    fromPath: string;
    toPath: string;
    redirectCreated: boolean;
    subtree: boolean;
  };
  visibility_changed: {
    fromGrant: PageGrant;
    toGrant: PageGrant;
  };
  page_trashed: {
    fromPath: string;
    toPath: string;
  };
  page_restored: {
    fromPath: string;
    toPath: string;
  };
  draft_published: {
    fromStatus: 'draft';
    toStatus: 'published';
  };
};
```

The visibility payload deliberately excludes `grantedUsers`, user ids, share
tokens, emails, and restricted-link claim details. If detailed ACL deltas are
needed later, they belong only in a separately authorized administrative audit
store.

An internal rename performed as part of trash or restore does not create a
`page_renamed` event. The outer lifecycle command creates exactly one
`page_trashed` or `page_restored` event.

### §5.3 Identity, idempotency, and indexes

- `_id` is generated before the Page CAS and copied into the outbox. It is the
  idempotency key for materialization.
- `operationId` is an opaque server-generated identifier. It is never accepted
  as a request field. Commands are instead keyed by a client-generated
  `Idempotency-Key` (16–128 URL-safe characters), which resolves to one durable
  `PageHistoryOperation` record before a Page is mutated. That record stores the
  actor/command scope, generated operationId, request fingerprint, original
  subtree page-id/from-path/to-path map, per-Page state, and expiry. A replay
  with the same key returns/resumes that record; a mismatch in command or
  fingerprint is rejected. A subtree operation shares its operationId across all
  affected Pages.
- **The recovery identity must exist before the request is sent.** Every
  path-reserving command (§6.2a) and subtree rename therefore *requires* the
  `Idempotency-Key`; it is not optional. The server also returns a short-lived
  signed `retryToken` naming the record and binding its nonce, but that token is
  a convenience only — a shorter, pre-resolved handle. **Recovery never depends
  on it**, because the failure a retry exists to survive is a lost response, and
  a lost response takes the returned token with it. A client that never received
  a response retries with the key it already holds.
- `{ page: 1, sequence: 1 }` is unique and supports timeline reads.
- MongoDB cannot enforce uniqueness across `Revision` and
  `PageHistoryEvent`. The Page allocator plus required sequence/empty-marker
  CAS is therefore the normative cross-collection invariant; the repair job
  verifies that no Revision/event pair shares a sequence before serving a
  ready Page.
- `{ page: 1, operationId: 1, kind: 1 }` is unique and makes command retries
  idempotent while allowing different kinds in one higher-level operation.
- Deletion records are a separate collection with their own indexes (§5.6);
  this collection needs no retention index because it has no retained
  membership that outlives its Page.
- Actor references may cease to populate after account deletion. The event
  document remains immutable; response projection returns a null or
  anonymized actor.

### §5.4 Page-local ordering

Page gains a monotonic `historySequence`, initialized to zero. A successful
history-producing Page CAS increments it and allocates the new value to exactly
one entry. The Page CAS is the sole allocator after cutover, so a valid
committed entry cannot share a sequence with another entry. Gaps are permitted
only for explicitly recorded migration repair; duplicate sequences are
corruption and block the Page for repair.

Content Revisions gain two additive bookkeeping fields, `historySequence` and an
optional `historyOperationId`. Existing and new Revision bodies, render
artifacts, storage type, and reconstruction semantics are unchanged. A Revision
without a committed sequence is not displayed by the merged endpoint. This
excludes a collaborative CAS loser, which currently can remain saved after the
Page pointer CAS fails (`packages/collab/src/save-flow.ts:354-386,415-433`).

`historyOperationId` is what lets a content row join the operation group that a
metadata row belongs to — a body-plus-grant save is one operation with two
committed rows, and without the field the content row could not be shown as part
of it. It is genuinely optional rather than merely nullable in the schema:
Revisions written before this RFC have no operation, and the backfill
(§13.2) does not invent one for them. Consequently **`operationId` is nullable
on content rows in the response contract** (§8.2); only `page_event` rows always
carry one, because every event is created by a command.

Existing Revisions receive sequences through the RFC-0008 migration in
`createdAt, _id` order within each Page. The migration records its boundary so
new writes cannot interleave with an unsequenced range.

### §5.5 Bounded Page outbox

Page also gains an optional `pendingHistoryEntry`:

```ts
type PendingHistoryEntry = { entryId: ObjectId } & (
  | {
      type: 'page_event';
      event: PageHistoryEventEnvelopeAndPayload;
    }
  | {
      type: 'content_revision';
      revisionId: ObjectId;
      sequence: number;
      occurredAt: Date;
      operationId: string;
    }
  | {
      type: 'migration_revision';
      revisionId: ObjectId;
      sequence: number;
      migrationOwner: string;
    }
);
```

The field is absent or contains one entry. It is not an embedded history
array. Every history-producing command must drain an existing entry before
attempting another Page CAS. This provides a hard document-size bound and a
per-Page serialization point without requiring an unbounded Page document.

`entryId` is generated when the entry is placed and exists on every variant.
**It is the sole identity the drain compares.** Clearing the slot is a
conditional update matched on `pendingHistoryEntry.entryId` and nothing else,
so a drain can only ever remove the entry its caller actually read.

The alternative — deciding "is this the same entry?" by comparing the entry's
contents — does not work, and the failure is not hypothetical. Comparing a
subset of fields lets a drain clear an entry that merely resembles the one it
read, which silently breaks the one-slot invariant this outbox exists to
provide. Tightening the comparison does not converge either: fields can be
added below the schema through the native driver, so any content-based match
has to keep growing to cover shapes the writer never declared. A single
opaque id removes the question instead of narrowing it.

Only the `page_event` variant has a natural id (`event._id`, the
materialization idempotency key of §5.3). `entryId` is deliberately separate
from it and present on all three variants, so the drain has one rule rather
than a per-variant rule.

The content variant exists only to durably finish the cross-collection
sequence assignment after the Page pointer CAS. It does not create a
PageHistoryEvent for a body save. The migration variant uses the same bounded
mechanism while writers are fenced; it never changes a Page revision pointer.

### §5.5a Tracking, migration, and operation state

Page gains a durable `historyTracking` object:

```ts
type HistoryTracking = {
  state: 'untracked' | 'migrating' | 'ready';
  trackingStartedAt?: Date;
  migrationOwner?: string;
  migrationLeaseUntil?: Date;
};
```

New Pages are created with `state: 'ready'` and an atomically written
`trackingStartedAt`. Existing Pages begin `untracked`; only the migration CAS
may move them through `migrating` to `ready`. A history endpoint returns
`409 history_migrating` for `untracked` or `migrating`, never a partial or
apparently complete timeline. Every history-producing writer requires
`historyTracking.state: 'ready'`; otherwise it returns retryable
`409 history_migrating` and does not mutate the Page.

`PageHistoryOperation` is a separate bounded collection, not Page-embedded
state. Its unique keys are `{ actor, command, idempotencyKey }` and retry-token
record id/nonce. It includes a lease and terminal result so takeover after a
crash is safe. A subtree record additionally persists the original target map
before work starts; retries use those immutable ids and paths, never a fresh
path scan.

### §5.6 Retention and the deletion record

Page-scoped events live exactly as long as their Page. `page_created`,
`page_renamed`, `visibility_changed`, `page_trashed`, `page_restored`, and
`draft_published` are removed during hard-delete cleanup, because after the
Page and its ACL are gone there is nothing left to authorize a read against.

Hard deletion is recorded in a **separate collection that is not keyed by
Page**, `PageDeletionRecord`:

```ts
type PageDeletionRecord = {
  _id: ObjectId;
  pageId: ObjectId;      // recorded value, not a reference — the Page is gone
  path: string;          // the path the Page occupied at deletion
  actor: ObjectId | null;
  deletedAt: Date;
  mode: 'user_hard_delete';
};
```

- `{ path: 1, deletedAt: -1 }` answers "what has happened at this path", newest
  first, across Pages that no longer exist.
- `{ deletedAt: -1 }` supports an administrative recent-deletions view.
- `{ pageId: 1 }` resolves a known id.

It carries no body, no ACL membership, no granted-user ids, no share tokens,
and no request metadata — the last path, who, when, and the mode.

**Records are retained indefinitely and there is no TTL index.** Two separate
reasons make an expiry wrong here rather than merely conservative:

1. Paths are reused. A Page created later at a path a deleted Page once
   occupied is a different Page with a different id, so a Page-keyed record
   could not surface the earlier deletion under that path even while it still
   existed. Keying by path is what makes the record findable at all.
2. An expiry deletes the answer to "who removed this" precisely in the case
   the question is asked late, which for a wiki page nobody visits often is
   the normal case. A hard delete that quietly erases its own evidence after a
   timer reproduces the gap this RFC exists to close.

Erasure remains available, but as an **explicit administrative operation
rather than a timer**. That keeps a deletion-on-request capability without
making forgetting the default.

The record is administrator-only. It is never returned by the ordinary page
history endpoint, which by construction serves a live Page.

No code path may call a bare Page `deleteOne` once writers are enabled.
`removePage`, `removePageById`, draft-cancel compensation, and redirect-origin
cleanup are routed through a deletion service with an explicit mode. A
`creation_cancel` mode durably records ownership in the creation operation,
purges that Page's ordinary history/revisions, and deletes the Page without a
deletion record; `redirect_stub_cleanup` does the same for a suppressed stub.
Only the Phase-4 `user_hard_delete` mode writes a `PageDeletionRecord`. This
prevents orphan page-scoped events after the Page and its ACL are gone, and
keeps the deletion record meaning "a user deleted a page" rather than "the
system cleaned something up".

The permission boundary and the explicit-erasure capability become normative
together in Phase 4.

## §6 Write protocol and consistency

### §6.1 Why best-effort dual write is rejected

Crowi supports standalone MongoDB, where multi-document transactions are not
available. Existing collaboration code explicitly avoids
`session.withTransaction` for this topology
(`packages/collab/src/compaction.ts:71-82`).

Neither dual-write order is safe:

| Write order | Crash result |
| --- | --- |
| Page mutation, then event insert | State changed but history permanently missing |
| Event insert, then Page mutation | History claims a state change that never happened |

Missing metadata facts cannot be derived later: old paths are overwritten,
only current grants survive, and grant-only changes retain no independent
actor or time. Therefore the first release includes the bounded outbox and
repair path.

### §6.2 Metadata and lifecycle command

For rename, visibility, trash, restore, and publish, the shared command service
first resolves `PageHistoryOperation`, then:

1. Loads the Page through the mutable/readable predicate, requires
   `historyTracking.state: 'ready'`, and drains an existing pending entry.
2. Reads the expected Page state, lifecycle version, `historySequence`, and an
   absent `pendingHistoryEntry`; computes the payload from that snapshot.
3. Performs one Page CAS whose predicate includes all of those expected values
   (including the expected sequence and empty outbox).
4. In that update writes the state change, `lastUpdateUser`, `updatedAt`, the
   required lifecycle advance, `$inc: { historySequence: 1 }`, and the one
   pending event with the allocated sequence.
5. Idempotently upserts the event by pending `_id`, then clears only that exact
   marker and dispatches projections.

A failed state predicate creates neither a state change nor an event. A crash
after step 4 leaves the complete event on the Page. Repeating step 5 is safe.

Visibility and publish complete within this shape. Rename, trash, and restore
additionally have to move a Page between two paths, which the unique path index
constrains; §6.2a defines their ordering.

Grant-only updates move off `page.save()` and into this command boundary. They
now update `lastUpdateUser` and `updatedAt` in the same Page CAS. The web
live-sync `PAGE_LEVEL_KEYS` must include both fields in its grant-only merge;
recent-page ordering and search access reindexing are therefore deliberate
effects.

This RFC changes where visibility changes are recorded. It does not change who
may perform them, how often, or what a page path may contain. Any throttling or
validation policy is a separate product decision with its own abuse model and
error contract.

### §6.2a Path-reserving operations (rename, trash, restore)

Rename-with-redirect, trash, and restore each move a Page between two paths and
may create or remove a redirect stub at the vacated or reclaimed path. These
operations are constrained by a fact the protocol must be built around rather
than assume away: **`Page.path` carries a unique index**
(`packages/api/src/models/page.ts:452`), so two Pages can never hold the same
path, not even momentarily. A stub therefore cannot be created at a path while
the moving Page still occupies it, and a Page cannot reclaim a path while a stub
still occupies it. The current implementation already respects this ordering —
it moves the source first and creates the stub afterwards
(`packages/api/src/models/page.ts:1961,1986`), and restore deletes the existing
stub before reclaiming the path (`page.ts:1796`).

Each of these operations runs from a durable `PageHistoryOperation` record and
proceeds in this order:

1. **Enter the transition.** One Page CAS moves the source to its destination
   path *and* into the non-readable/non-mutable `renaming` state, in the same
   update, recording the original path/status on the operation record. This is
   the step that frees the source path; there is no intermediate state in which
   the source is both readable and moved.
2. **Settle the vacated path.** For rename-with-redirect and trash, create the
   redirect stub at the now-free original path in explicit
   `historyMode: 'suppress'`. For restore, this step runs *before* step 1
   instead: delete the redirect stub occupying the destination path under
   `deleteMode: 'redirect_stub_cleanup'`, so that step 1's CAS can take it.
3. **Leave the transition and allocate the event.** A final CAS moves the source
   out of `renaming` into its target status, increments `historySequence`, and
   writes the one pending event whose payload records what actually happened in
   step 2.

Because the event is allocated only in step 3, `redirectCreated` remains a
durable post-create fact — it is never asserted before the stub exists. A crash
between any two steps leaves the operation record and a source Page in
`renaming`, from which a later worker resumes; the Page is unreadable and
unmutable throughout, so no partial state is observable.

**The vacated path is briefly unoccupied between steps 1 and 2, and standalone
MongoDB cannot close that window.** The same window exists in the current
implementation. The protocol therefore does not depend on winning it: if step 2
finds the original path taken by a foreign Page, the operation completes with
`redirectCreated: false` and a recorded reason. A lost stub race must not strand
a Page in `renaming`.

Internal stub creation creates neither `page_created` nor a content-history
entry. Its removal must use `deleteMode: 'redirect_stub_cleanup'`, which is
auditable in the operation record and is forbidden from producing a
`PageDeletionRecord`. User-requested hard delete uses a distinct mode.

### §6.3 Content save and sequence assignment

Content save preserves the existing Revision-first shape:

1. Prepare and save a content Revision with no committed sequence.
2. Drain the Page outbox.
3. Atomically compare the expected Page pointer, lifecycle state,
   `historyTracking.state: 'ready'`, expected `historySequence`, and empty
   outbox; then advance both current Revision pointers, update timestamps,
   increment historySequence, and put a `content_revision` assignment in the
   pending entry.
4. Copy the allocated sequence and the operationId to the referenced Revision
   with an idempotent conditional update.
5. Clear the matching pending entry.
6. Dispatch content side effects.

If the Page CAS loses, the saved Revision has no sequence and the post-cutover
merged history endpoint excludes it. If a concurrent metadata command wins,
the content saver reloads the Page, drains its entry, and retries from a fresh
sequence; it never reuses a stale allocation. If the process crashes after the
CAS, the Page outbox identifies the winning Revision and sequence, so a drain
completes the assignment.

Both normal and draft creation use the same command service; the current direct
draft `Page.create` path is removed. A Page begins `creating`, which is not
readable or mutable, with `historyTracking.ready` and a durable creation
operation record. It materializes `page_created`, commits the initial content
sequence, and only then exposes the requested draft/published state. A restart
resumes the record. Draft publication is also moved out of the collab
fire-and-forget `updateOne` into the shared publish command; it drains the
content marker and performs its own sequenced `draft_published` CAS.

When one request changes both body and grant, the content save and visibility
change are two ordered commands with the same `operationId`. Each drains its
own pending entry before the next begins. Standalone MongoDB does not make the
two domain changes all-or-nothing, but it does ensure that every state change
which becomes durable has its corresponding durable history row.

### §6.3a Authoritative lifecycle gate

The Page schema adds `creating`, `renaming`, and `deleting` statuses. One
model-level predicate is authoritative: `isReadablePageState` permits only
normal draft/published states subject to the existing draft grant rules, and
`isMutablePageState` permits only those states plus the command's explicitly
owned transition. The implementation must use these predicates in every normal
by-id/by-path read (`findPageById`, `findPageByIdAndGrantedUser`, `findPage`,
and `findPageByPath`), `Page.exists`, `findExistingTwin`, and
`checkPagesRenamable`; in HTTP and WebSocket authorization; in background
workers; and in search's status keep-set. The collab pointer CAS must require
an allowed mutable status rather than merely `status != deleted`.

Transition ownership is the creation/rename/delete operation record. No other
writer may target a transitional Page. This prevents a collab save from
creating a Revision after hard-delete purge, and prevents creating/deleting or
renaming Pages from being indexed or exposed by an ordinary read.

### §6.4 Repair and read behavior

Repair is available from three paths:

- the next command on the same Page;
- a startup/background scanner over Pages with `pendingHistoryEntry`; and
- an operator repair command for a specific Page or event id.

The repair worker uses a lease or compare-and-set only to reduce duplicate
work; correctness comes from idempotent target updates and exact marker-clear
predicates.

History reads are read-only, including for `pages:read` OAuth/PAT credentials.
They never drain or clear a marker. They directly project a valid pending entry
at its allocated sequence and deduplicate it by `_id`/revision id against a
materialized target. A corrupt marker or unreadable referenced Revision is a
server error plus a repair alert, not an empty history row.

### §6.5 Subtree rename

A subtree rename creates `PageHistoryOperation` before changing any Page and
persists the full target Page-id/from-path/to-path map. Standalone MongoDB
cannot make the entire tree atomic. The command returns succeeded/failed ids
plus the operation's signed retryToken.

A retry presents either the retryToken (when the client received a response) or
the same `Idempotency-Key` it generated before the first attempt (when it did
not) — never an operationId. Both resolve to the same record, so the retry
resumes the identical persisted map and operationId, and already-committed
`{ page, operationId, kind }` rows are idempotent. **The key path is the one
that matters**: a client that times out mid-operation has no token, and that is
exactly the case subtree recovery exists for.

Every affected Page receives its own `page_renamed` event and sequence.
`subtree: true` plus the shared operationId lets the UI identify the operation
group. A partial failure never erases events for Pages already moved.

Best-effort rewriting of historical `Revision.path` remains display
denormalization and is not part of event commit correctness. History joins
remain id-based.

## §7 Hard delete state machine (Phase 4)

Hard-delete history is not enabled before Phase 4. Phase 4 cannot use the
normal mutation protocol and then immediately delete the Page, because doing
so would also delete its only pending outbox. It uses a retryable lifecycle
state:

1. CAS the Page into `deleting`, block normal reads/writes, and record in the
   operation that a deletion record is owed for this Page and path.
2. Write the `PageDeletionRecord` idempotently, keyed by the operation. It
   lives in its own collection, so it neither consumes a Page sequence nor
   depends on the Page surviving.
3. Idempotently purge content Revisions and child documents, then repeat the
   child sweep until a pass finds nothing (see below).
4. Remove the Page's PageHistoryEvent documents. All of them are page-scoped,
   so none is exempt.
5. Delete the Page last.

The deletion record survives step 5 by construction — it is not keyed by the
Page and carries no reference that the deletion invalidates. Removing it is a
separate, explicit administrative operation (§5.6), never a step of this state
machine and never a timer.

### §7.1 Child writes that were already authorized

Blocking reads and writes at step 1 is not sufficient, because **child-document
creation authorizes the Page and inserts as two separate operations.** Comment
creation resolves and authorizes the Page, then inserts the Comment
(`packages/api/src/hono/handlers/comment.ts:154,159`); attachment upload
authorizes, performs an external storage upload that can take arbitrary time,
and only then creates the Attachment. A request that passed authorization before
the `deleting` CAS can therefore insert its child *after* the purge in step 3
has already run, leaving an orphan that references a Page which no longer
exists. Extending the lifecycle predicate to reads and collab saves does not
close this, because these writers never re-read the Page.

Two mechanisms are required together:

- **The child writer re-validates after its insert.** Every path that creates a
  Page-scoped child document (Comment, Attachment, and any future equivalent)
  re-reads the Page's lifecycle state and epoch immediately after the insert
  succeeds. If the Page has left the mutable set, the writer deletes the child it
  just created and fails the request with the ordinary not-found-style response.
  This makes the writer responsible for its own window instead of asking the
  deleter to guess at it. External storage objects created by an interrupted
  attachment upload are removed on the same path.
- **The deleter sweeps until quiescent.** Step 3 repeats the child scan until one
  full pass finds nothing to remove. This terminates: once `deleting` is durable,
  no new request can pass authorization, so the number of in-flight authorized
  requests is finite and strictly decreasing. A bounded retry budget with an
  operator alert covers a pathologically stuck upload rather than looping
  forever.

Neither mechanism alone is sufficient — the sweep alone still races the last
in-flight insert, and re-validation alone leaves a child that was inserted and
compensated after the sweep but before Page deletion.

Every cleanup step is idempotent. A worker scans `deleting` Pages and resumes
from the first incomplete step. The ordinary page-history endpoint never
serves a deleting or deleted Page. An administrator audit endpoint authorizes
deletion-record lookup independently, because current Page ACL cannot be
evaluated after deletion — the record is keyed by path, not by a Page whose
grants no longer exist.

Internal redirect-stub cleanup during restore is not a user-facing hard delete
and does not create a deletion record. It requires the explicit
`redirect_stub_cleanup` mode recorded by the enclosing operation. The outer
restore event is authoritative.

## §8 Merged history API and contract

### §8.1 Prefix-independent route

The contract adds one route relative to the active API root:

```text
GET /pages/{pageId}/history?cursor=<opaque>&limit=<1..100>
```

This notation intentionally does not fix the deployment prefix. It remains
valid while Crowi transitions between API root prefixes.

The route requires normal Page read authentication and the existing
`pages:read` scope. It loads the Page by immutable id through the current grant
check before reading either source. Missing and inaccessible Pages use the
existing not-found-style response.

Contracts for the path-reserving commands (rename, subtree rename, trash,
restore) and Phase-4 hard delete **require** a client-generated
`Idempotency-Key` from the first attempt, and additionally accept a `retryToken`
on subsequent attempts (mutually exclusive with the key). Grant-only changes and
content saves keep it optional: they have no multi-step operation to resume, and
their existing CAS predicates already make a duplicate submission either a
no-op or an ordinary conflict.

This is a breaking contract change for rename, and it is taken deliberately:
`/api/v2` is not in production, so no compatibility shim is planned. The
existing rename contract declares no idempotency field
(`packages/api-contract/src/schemas/page.ts:349`) and the web rename dialog
sends none (`packages/web/src/components/page-view/rename-dialog.tsx:205`), so
the client work is part of this RFC's implementation, not an assumption about
what clients already do.

Responses return a retryToken while the durable operation remains resumable.
Existing raw `operationId` fields are neither added nor accepted.

### §8.2 Discriminated response

The response is defined in `@crowi/api-contract` and represented
conceptually as:

```ts
type PageHistoryEntry =
  | {
      type: 'content_revision';
      sequence: number;
      occurredAt: string;
      operationId: string | null;
      revision: RevisionMeta;
    }
  | {
      type: 'page_event';
      sequence: number;
      occurredAt: string;
      operationId: string;
      actor: PageUser | null;
      event:
        | { kind: 'page_created'; payload: PageCreatedPayload }
        | { kind: 'page_renamed'; payload: PageRenamedPayload }
        | { kind: 'visibility_changed'; payload: VisibilityChangedPayload }
        | { kind: 'page_trashed'; payload: PageTrashedPayload }
        | { kind: 'page_restored'; payload: PageRestoredPayload }
        | { kind: 'draft_published'; payload: DraftPublishedPayload };
    };

type PageHistoryResponse = {
  entries: PageHistoryEntry[];
  nextCursor: string | null;
  trackingStartedAt: string;
  trackingState: 'ready';
};
```

The ordinary endpoint serves a live Page, so deletion records cannot appear in
it by construction rather than by filtering. Content rows contain
Revision metadata but not `body` or `renderedAst`. Existing authorized
Revision detail endpoints remain the source for diff, historical rendering,
and restore.

### §8.3 Ordering and cursor

The API orders newest-first by the total tuple
`(sequence, kindRank, stableId)`, where `content_revision` and `page_event`
have fixed documented ranks and `stableId` is Revision/Event `_id`. The opaque
cursor binds the Page id and the full tuple. A healthy post-cutover Page has
unique sequence, but the tuple makes pagination non-lossy while duplicate
sequence corruption is detected and queued for repair.

Sequence remains the order authority; kindRank and stableId are cursor
tie-breakers only. `occurredAt` is display-only. This avoids same-millisecond
ambiguity across replicas and prevents an orphan collaborative Revision from
appearing merely because it has a timestamp.

The client must not fetch two independently paginated sources and merge them.
Doing so breaks ordering at page boundaries and can skip or duplicate entries.

The existing offset-paginated Revision list remains content-only for current
consumers (`packages/api-contract/src/schemas/revision.ts:36-48`). The History
screen moves to the new cursor endpoint in one coordinated release.

## §9 History UI and inverse actions

The History screen renders one timeline. Content rows retain from/to selectors,
Revision links, contributor information, and body diff. Event rows show a
localized action summary, actor, time, and typed detail. Event rows never show
diff radios and never render a “no content changes” diff.

The current implementation assumes every list row is a Revision and compares
`fromRevision.body` to `toRevision.body`
(`packages/web/src/components/page-history/revision-diff.tsx:100-130`). The new
controller derives its selectable content list by filtering
`type === 'content_revision'`. Metadata rows between two content rows do not
change which content revisions are compared.

Inverse actions are explicit:

| History row | Available action |
| --- | --- |
| Content Revision | Restore this body as a new content Revision |
| Rename | Rename again to the prior path if authorization and path availability pass |
| Visibility | Apply the prior grant category after current permission checks |
| Trash / restore | Use the normal lifecycle command |
| Creation / publication | Informational in the first release |

Every inverse metadata action validates current state and may fail with a
conflict. Success creates a new event. Historical events are never mutated or
marked as if content restore had reversed them.

The UI shows a tracking boundary. It does not claim that metadata changes
before `trackingStartedAt` are complete.

## §10 Side-effect routing

Command results use an exhaustive kind rather than a
`revisionCreated: boolean` inference:

| Committed kind | Search | Backlinks | Render/access cache | Presence/collab | Activity/Notification |
| --- | --- | --- | --- | --- | --- |
| Content Revision | Reindex | Reparse body and bind `fromRevision` | Invalidate rendered content | Content refresh | Existing UPDATE projection |
| Page created | Index | Parse initial body through content path | Initialize | Normal document availability | Auto-watch; no required Activity |
| Rename | Update path | Path-dependent repair only | Path-dependent invalidate | Lifecycle invalidation, no content refresh | Optional projection |
| Visibility | Reindex access | None | Invalidate access-controlled caches | No content refresh | Re-evaluate recipients before any projection |
| Trash | Remove/reindex state | State-dependent cleanup | Invalidate | Close lifecycle | No required notification |
| Restore | Reindex | State-dependent repair | Invalidate | Reopen lifecycle | Optional projection |
| Publish | Index published state | Content save handles body | Invalidate | Content save handles refresh | Content save handles UPDATE |
| Hard delete | Remove | Delete | Delete | Close | Admin audit only |

Metadata events never become backlink `fromRevision` values and never trigger a
presence content refresh. Activity and Notification failures do not roll back
or delete history. A future Activity projection flows from
PageHistoryEvent to Activity, never in the opposite direction.

## §11 Failure handling

| Failure | Required result | Mechanism |
| --- | --- | --- |
| Validation or CAS fails before Page mutation | No state change and no history entry | State and sequence predicates |
| Crash after Page mutation and pending marker | State plus recoverable history | Bounded outbox |
| Crash after event upsert before marker clear | One event after repair | Deterministic `_id`, idempotent upsert |
| Crash after content pointer CAS before Revision sequence update | Winning Revision recovered and sequenced | Content pending marker |
| Collaborative Revision loses Page CAS | Revision is not displayed | No committed sequence |
| Concurrent command advances sequence or fills marker | Loser reloads/drains/retries | Sequence and empty-marker CAS predicates |
| Side effect fails | History remains committed and side effect can retry | Durable entry is upstream |
| Revision path rewrite fails after rename | Page and event are correct; display path can be repaired | Id-based ownership |
| Subtree rename partially fails | Successful Pages retain events; failed Pages retry | Shared operationId, per-Page CAS |
| Subtree response is lost | Same operation resumes without a path rescan | Durable operation keyed by the client-generated Idempotency-Key |
| Source vacated its path but the stub was not yet created | Operation resumes; a lost path race yields `redirectCreated: false` | Durable operation record plus unreadable `renaming` state |
| Child document inserted after hard-delete purge | Child is compensated by its own writer; sweep repeats to quiescence | Post-insert lifecycle re-validation (§7.1) |
| Pre-predicate replica writes an unsequenced Revision on a ready Page | Anomaly detected, sequenced, and reported | Repair scan on absent `historySequence` (§13.2a) |
| Trash/restore internal rename runs | One lifecycle event, not an extra rename event | Outer-command kind |
| Hard-delete cleanup stops | Resume from deleting Page | Lifecycle state machine |
| History read sees pending event | Directly project it, never omit silently | Read-only projection/dedup |
| Migration lease is held | Writer does not mutate | Retryable `409 history_migrating` |
| Actor no longer resolves | Return null/anonymized actor | Immutable nullable reference |
| Activity or Notification insert fails | History and Page state remain committed | Best-effort downstream projection |

## §12 Security, privacy, correctness, and resource bounds

### §12.1 Authorization and existence hiding

- The ordinary endpoint first authorizes the current Page by immutable id and
  current grant.
- Past paths are never used for authorization.
- Missing, inaccessible, deleting, and deleted Pages use existing
  not-found-style behavior.
- Deletion records use a separate administrator authorization boundary and are
  never returned by the ordinary endpoint.
- Inverse actions re-run current authorization and conflict checks; history
  visibility does not grant mutation rights.

### §12.2 Payload minimization

A Page that changes from owner-only or restricted to public exposes its past
page-history rows to newly authorized viewers. This RFC accepts that currently
authorized viewers may see historical `fromPath` and `toPath`, including a path
that previously belonged to a private namespace. That is an explicit product
policy.

The corresponding mitigation is strict payload minimization:

- visibility events contain only grant enum before/after values;
- no granted-user ids, emails, share tokens, link claims, request bodies, or
  arbitrary metadata are stored;
- deletion records contain only the last path, actor reference, time, and
  deletion mode, and are administrator-only; and
- actor disappearance changes response projection, not the event document.

Event path fields store the Page's path exactly as it was. **This RFC does not
change page-path validation.** A history store must be able to record every path
a Page can actually have; narrowing the accepted character set or length here
would make already-existing Pages unrecordable, and the create/rename contracts
place no such limit today
(`packages/api-contract/src/schemas/page.ts:307,349`), while
`Page.isCreatableName` forbids a different and narrower set
(`packages/api/src/models/page.ts:882`).

Rendering safety is therefore achieved where the string is rendered, not by
restricting what may exist: the web timeline renders all payload strings as
React text nodes, never Markdown, `raw()`, or dangerous HTML, and a
historical-path link uses `pagePathToHref` (or equivalent segment URL encoding),
never string interpolation into an href. Storage applies only the bound implied
by the Page document itself.

### §12.3 Notifications and logs

Any Activity or Notification projection evaluates current access at dispatch
and retry time. A visibility transition must not send old private Page details
to a recipient who no longer has access. Structured logs may contain event id,
Page id, kind, operationId, and repair state but not arbitrary payloads or ACL
membership.

### §12.4 Bounds

- A Page has at most one pending history entry.
- The endpoint limit is 1–100, with 50 as the default.
- Cursors are opaque and Page-bound.
- Event paths inherit whatever bound the Page document already imposes; this RFC
  adds none (§12.2). operationId is a server-generated 32-byte opaque
  identifier; idempotency keys and retry tokens are separately validated before
  lookup.
- `operationId` is never accepted verbatim from an external request. A signed
  retryToken and an Idempotency-Key are accepted only to resolve their durable
  operation record. Operation records are bounded by their expiry, and a key is
  scoped to one actor and command.
- Background repair is batch-limited and resumable.
- Subtree rename retains the existing concurrency bound and adds no unbounded
  embedded Page data.

## §13 Migration and rollout compatibility

### §13.1 Schema and index expansion

Add `PageHistoryEvent`, Page `historySequence`,
`pendingHistoryEntry`/`historyTracking`, `PageHistoryOperation`, and the
additive Revision `historySequence` field. Build event indexes before enabling
writers, plus Revision `{ page: 1, historySequence: -1, _id: -1 }` for merged
reads and a plain non-sparse `historySequence: 1` index so the RFC-0008
`{ historySequence: null }` pending probe is index-backed (as `Revision.type`
already is). Page defaults remain readable during expansion, but
history-producing writes stay behind the migration gate.

### §13.2 Existing Revision sequence backfill

The RFC-0008 migration processes one Page at a time using an atomic Page lease,
not the runner's append-only migration record:

1. acquire with `findOneAndUpdate` matching `historyTracking.state: 'untracked'`
   or an expired `migrating` lease, and set `state: 'migrating'`, a random
   owner, and a short renewable lease;
2. while the owner/lease CAS remains valid, load its next unsequenced Revision
   in `createdAt, _id` order, then use the same one-slot outbox: a Page CAS
   matching unexpired owner lease, expected `historySequence`, and empty marker
   increments the sequence and writes a `migration_revision` marker; idempotently copy that
   sequence to the Revision and clear that exact marker. A takeover drains any
   marker before allocating another value;
3. verify count/uniqueness and atomically set `historySequence`,
   `trackingStartedAt`, and `state: 'ready'` with a predicate matching that
   owner and lease; then clear the lease; and
4. on a crash, a later worker may acquire only after expiry and resumes from
   the already assigned maximum.

Every content or metadata writer requires `ready` and therefore returns
retryable `409 history_migrating` while this lease is held; it cannot write
between the scan and final sequence. This intentionally rejects rename/save
requests for an unmigrated Page rather than creating a permanent history hole.
The migration framework may invoke contenders on every replica, but only this
Page CAS owns a Page at a time.

### §13.2a Version skew: what the lease does and does not fence

**The lease fences only writers that evaluate `historyTracking.state`.** A
replica running the previous release evaluates neither that field nor the new
transitional statuses: the HTTP save path writes a Revision and updates the Page
with no tracking predicate (`packages/api/src/models/page.ts:1599`), and the
collab save path's CAS matches only the revision pointer, status, and lifecycle
epoch (`packages/collab/src/save-flow.ts:409`). Such a replica can append an
unsequenced Revision to a Page that the migration has already scanned and marked
`ready`. No predicate added by this RFC can stop it, because a predicate is only
as good as the writer that reads it.

Two consequences follow, and the RFC takes both rather than pretending the lease
is sufficient.

**The migration is an operator-triggered step, not a boot migration, and it must
not overlap a rolling deploy.** Its documented precondition is that every api and
collab replica already runs the release that introduced the tracking predicate.
This is a weaker guarantee than a CAS — it is an operational instruction — but it
is honest, and it is not an unusual demand here: because writers reject
`untracked` Pages (§5.5a), the migration is already a write-affecting maintenance
event rather than something to run casually alongside live traffic. The existing
migration policy places heavy transformations in an operator-controlled window
for the same reason (`packages/api/src/migration/types.ts:14`).

**A skew violation must be detectable and repairable rather than silent.** The
failure mode of an unsequenced Revision on a `ready` Page is that it is invisible
in history — silence, not an error. The repair job therefore scans for exactly
that condition: a Revision whose Page is `ready` and whose `historySequence` is
absent. Such a Revision is not discarded; the repair allocates a fresh sequence
through the normal Page CAS, copies it in, and records the anomaly with an
operator alert. Sequences are page-local and allocation-ordered, so a late
assignment orders the row after the rows already committed — which is where it
belongs, since it was in fact written later. This converts an undetectable
history hole into a detected, repaired, and reported event.

The plain non-sparse `historySequence: 1` index added in §13.1 is what makes this
scan index-backed rather than a collection sweep.

Historical orphan Revisions cannot be classified perfectly from old state, so
the legacy timeline sequences every row associated through `Revision.page` and
retains the existing list semantics. It does not claim legacy CAS-loser
exclusion. From cutover onward, only Page-CAS winners receive a sequence.

If Revision volume makes an all-at-once migration operationally unsafe, the
same per-Page state machine may roll out in batches. A Page uses the old
content-only History screen until its migration state is complete; it never
serves a partially ordered merged timeline.

### §13.3 No metadata backfill

Crowi does not synthesize historical rename, visibility, trash, restore, or
publish events. `Revision.path` has been rewritten on rename, Page stores only
current visibility, and grant-only operations have no independent timestamp or
actor. Inferring events would create false audit facts.

Existing Pages show their sequenced content Revisions plus the durably stored
`trackingStartedAt` boundary only after their tracking state is `ready`; an
untracked/migrating Page returns `409 history_migrating`. New Pages write that
same boundary in their creating CAS. `page_created` is emitted only for Pages
created after the new writer is enabled. The implementation does not mass-create
`history_tracking_started` or synthetic creation events.

### §13.4 Contract and UI cutover

The new route and schemas land in `@crowi/api-contract`, followed by regenerated
OpenAPI JSON, YAML, and generated TypeScript. The web History screen switches
from the Revision list to the merged endpoint only after event writers,
outbox repair, and the Page's sequence migration are active. Existing Revision
detail and diff routes remain.

## §14 Tests and acceptance criteria

### §14.1 Model and command tests

- Rename, visibility, trash, restore, publication, and creation write the state
  change, sequence increment, and pending entry in one Page atomic update.
- Event materialization repeated any number of times produces one document.
- Marker clearing cannot clear a newer pending entry.
- Grant-only changes update `lastUpdateUser` and `updatedAt`.
- Trash and restore do not emit an internal `page_renamed`.
- Body-plus-grant operations produce ordered content and visibility entries
  with one operationId.
- Subtree retry produces no duplicate events and reports partial success.
- A retry that never received a response — presenting only the client-generated
  `Idempotency-Key` — resumes the same persisted subtree page-id/path map and
  operationId. The same holds for a retry presenting the returned retryToken.
  Mismatched replay of either is rejected.
- A path-reserving command submitted without an `Idempotency-Key` is rejected by
  the contract.
- Rename, trash, and restore never attempt to place two Pages at one path: the
  source's move out of its original path and the stub's creation there are
  separate updates in that order, and restore removes the occupying stub before
  reclaiming the path. A stub creation that loses the vacated path to a foreign
  Page yields `redirectCreated: false` and still completes the operation, never
  stranding the source in `renaming`.
- The Page outbox never contains more than one entry.
- Every content and metadata CAS rejects stale sequence or non-empty outbox;
  a stalled metadata marker cannot be overwritten by a collab save.
- Redirect creation failure produces no completed outer event; internal stub
  create/delete modes produce neither creation history nor deletion records.
- Normal and draft creation, plus collaborative publication, use the shared
  creating/publish command service and produce their required entries.
- By-id/by-path reads, WebSocket saves, workers, twin checks, rename checks,
  and search all reject creating, renaming, and deleting Pages.

### §14.2 Crash and repair tests

Failure injection covers every boundary in §6 and every row in §11:

- before Page CAS;
- after Page CAS;
- after event upsert;
- after Revision save but before pointer CAS;
- after pointer CAS but before Revision sequence assignment;
- after target materialization but before marker clear;
- between each step of a path-reserving operation (§6.2a), including a crash
  after the source has vacated its path but before the stub exists;
- during each hard-delete cleanup step;
- after a child writer has authorized but before it inserts, and after it
  inserts but before it re-validates; and
- during downstream Activity, Notification, search, backlink, cache, and
  presence work.

Startup, next-command, read-time, and operator repair converge on the same
single event or content sequence.

Two cases are called out because they are the ones a predicate cannot cover:

- A comment or attachment whose request authorized before the `deleting` CAS and
  inserted after the purge is compensated by its own writer, and the deleter's
  repeated sweep terminates with no child remaining (§7.1).
- A Revision written by a replica that does not evaluate the tracking predicate
  after its Page became `ready` is found by the repair scan, assigned a sequence,
  surfaced in history, and reported — not left invisible (§13.2a).

### §14.3 History API tests

- The server merges Revision and PageHistoryEvent rows by sequence.
- Cursor pagination has no gaps or duplicates across mixed entry kinds.
- Same-millisecond entries and multiple API replicas remain correctly ordered.
- A collaborative CAS loser is excluded.
- Legacy migrated rows retain legacy list semantics, including the documented
  possibility of a historical CAS loser.
- Content rows omit body and rendered AST.
- A migrated legacy content row returns `operationId: null` and is not grouped
  into any operation; a body-plus-grant save returns a content row and a
  visibility row sharing one operationId.
- Current Page grant is required before either source is queried.
- Restricted-to-public transitions expose only minimized payloads.
- Deleted/suspended actors return null or anonymized references.
- A pending committed entry is not omitted.
- Deletion records are unreachable through the ordinary endpoint.

### §14.4 Web tests

- Event rows have no diff radio and no “no changes” body-diff message.
- Content-to-content selection remains correct when events appear between the
  two Revisions.
- Revision deep links and historical rendering remain unchanged.
- Rename, visibility, trash, and restore inverse actions show current-state
  conflicts instead of mutating old events.
- The tracking boundary is visible for migrated Pages.
- Subtree operation grouping is accessible without relying on color alone.
- Event payloads render as text, and historical links are URL-encoded through
  `pagePathToHref`. A Page whose path contains `<`, `>`, quotes, or `&` is
  recorded and rendered without escaping into markup and without being rejected
  at write time.
- Grant-only live sync updates `updatedAt` and `lastUpdateUser`.

### §14.5 Regression tests

- RFC-0018 quote anchors accept content Revision ids only.
- RFC-0009 compaction never reads PageHistoryEvent.
- Backlink `fromRevision` always references a content Revision.
- Rename and visibility do not publish a presence content refresh.
- Metadata events do not change seen-by state.
- Activity/Notification failure cannot roll back Page state or history.
- Existing Revision list/detail consumers remain content-only.
- Hard delete leaves no Page, Revision, or page-scoped event, and leaves
  exactly one deletion record, which survives the Page.
- A path reused after a hard delete still resolves the earlier deletion record
  under that path, and the new Page's own history contains none of it.
- Phase-4 hard-delete tests cover a collab save racing purge and prove no
  orphan Revision can remain; ordinary physical draft/redirect cleanup is
  either explicitly in redirect cleanup mode or cannot create history.
- Competing replicas can acquire only one migration Page lease; writers return
  `409 history_migrating`, and resumed migration preserves the durable
  tracking boundary and sequence maximum.
- Cursor pagination remains complete under injected duplicate-sequence
  corruption and queues repair rather than dropping a co-sequenced entry.

## §15 Alternatives considered

### §15.1 Metadata-only Revision rows

MediaWiki's null revision is a successful version of this pattern, but its
storage structure is materially different. A MediaWiki revision points through
slot/content/text indirection, so a null revision can point to the same content
without copying the article.

Crowi stores `body` as a required inline field and `renderedAst` inline on the
Revision row (`packages/api/src/models/revision.ts:179,245-254`). It therefore
cannot create the same cheap dummy row:

- copying body and rendered AST for every rename grows storage in proportion
  to content size and cancels RFC-0009's compaction benefit;
- making body nullable redefines the schema, API contract, reconstruction
  chain, diff path, and RFC-0018 quote anchor at once; and
- adding a reference to another content Revision puts two incompatible row
  kinds in the same collection and forces every consumer to maintain a
  permanent kind exclusion.

The current web diff reads both Revision bodies and treats equality as a
content “no changes” case
(`packages/web/src/components/page-history/revision-diff.tsx:100-130`).
Backlinks require Revision body and bind their source to the Revision
(`packages/api/src/models/backlink.ts:146-205`). Similar permanent branching
would be required in restore, rendering, compaction, quoting, presence, and
live synchronization.

MediaWiki proves that null revisions work with content indirection; it does not
justify adding them to Crowi's inline-content Revision model. Rejected.

### §15.2 Promote Activity to the history authority

Activity is not append-only. Unlike deletes LIKE, comment deletion deletes
COMMENT, and hard page deletion removes all Page Activities. It has no
before/after schema and content UPDATE Activity does not store a revision id.
Changing these semantics would affect notification grouping and every existing
consumer, while a server-side merge with Revision would still be required.

Confluence provides the corresponding product failure mode: its audit log does
not record content edits or location changes, while page history does not
provide title-change history. A notification/audit-oriented log and a content
version list can leave rename in the gap for years if no merged read model is
normative.

`PageHistoryEvent -> Activity -> Notification` remains a valid projection.
`Activity -> page history` is rejected.

### §15.3 Unbounded embedded Page history

Embedding all events would make the Page mutation and append single-document
atomic, but creates unbounded document growth, 16 MB BSON risk, hot-document
write amplification, projection leakage, difficult pagination, and complete
history loss on Page deletion.

This RFC reuses only the useful bounded part: one pending outbox slot. Rejected
as the history store.

### §15.4 Best-effort dual write first

This reduces initial implementation cost but creates permanent, undetectable
holes. No later migration can recover an old path, prior grant, actor, or
subtree operation boundary that was never recorded. Rejected; bounded outbox
and repair ship in the first release.

### §15.5 Client-side merge of two paginated endpoints

Independent pagination has no stable shared page boundary. A metadata event
inserted between two client fetches can cause omission, duplication, or
misordering. It also cannot reliably exclude uncommitted Revisions. Rejected
in favor of one server cursor.

### §15.6 One timeline collection holding reference rows for content revisions

Rather than merging two sources at read time, the timeline collection could also
receive a lightweight reference row for every content Revision, so history is one
collection read by one cursor with no merge, no cross-collection sequence
invariant, and no tie-break rank. This is the most attractive alternative in the
list, and it is rejected for one reason.

**Content saves are self-recording; metadata changes are not.** A Revision's
existence *is* its history entry — it is durable the moment it is written, and
nothing else has to happen for the save to appear in history. A metadata change
has no such artifact: after a rename, the old path is simply gone, and after a
grant change, only the current grant survives. The outbox exists precisely to
manufacture, for metadata, the durability that content already has.

Adding a reference row therefore does not unify two mechanisms; it exports the
weaker mechanism onto the stronger one. Every body save would have to carry the
outbox protocol, placing it on the hottest write path in the product, and a crash
between the Page CAS and the timeline insert would make a save that is durably
stored *vanish from its own history*. Today that is structurally impossible.

The asymmetry is the design, not an oversight in it. The costs the alternative
removes — a server-side merge and a documented tie-break rank — are paid once in
one endpoint (§8.3); the cost it adds is paid on every save forever. Rejected.

### §15.7 Full-state restore

Restoring body, path, grant, status, redirect state, and ACL membership from
one historical point creates security and availability hazards: the current
visibility may expose old private content, the old path may be occupied, and
old ACL subjects may no longer be valid. Rejected in favor of body-only
Revision restore and explicit metadata inverse actions.

## §16 Phased plan

### §16.1 Phase 1 — durable model, ordering, and repair

- Add PageHistoryEvent schemas and indexes.
- Add Page sequence, tracking state, and one-slot outbox.
- Add durable PageHistoryOperation/idempotency and signed retry-token support.
- Add additive Revision sequence bookkeeping.
- Implement idempotent materializers, read-only pending projection, background repair, and
  operator repair.
- Add the creating, renaming, and deleting lifecycle state machines and the
  shared authoritative status gate.
- Add post-insert lifecycle re-validation and compensation to Page-scoped child
  writers (§7.1).
- Add failure-injection tests before enabling writers.

### §16.2 Phase 2 — command cutover and migration

- Move rename, grant, trash, restore, publish, and create into typed command
  services.
- Replace direct draft creation and collab's fire-and-forget publication with
  those command services; add explicit redirect create/cleanup modes.
- Make grant-only timestamps consistent.
- Allocate content sequences at HTTP and collaborative Page CAS boundaries.
- Require the client-generated `Idempotency-Key` on path-reserving commands and
  update the web clients that issue them.
- Backfill existing Revision sequences in resumable Page batches, as an
  operator-triggered step whose precondition is that no pre-predicate replica is
  still running (§13.2a).
- Add the unsequenced-Revision repair scan and its operator alert.
- Add event-kind side-effect dispatch.

### §16.3 Phase 3 — merged contract and History screen

- Add the prefix-independent history route to `@crowi/api-contract`.
- Regenerate OpenAPI artifacts.
- Implement one cursor over both sources.
- Switch the web History screen to discriminated rows.
- Keep body diff and deep links on existing Revision detail routes.
- Show tracking boundaries and subtree operation groups.

The merged endpoint and UI are required deliverables, not optional follow-up.
Shipping event recording without an integrated timeline would reproduce the
gap this RFC exists to close.

### §16.4 Phase 4 — hard-delete administration and hardening

- Enable the complete hard-delete state machine together with the
  path-keyed `PageDeletionRecord`, admin-only lookup, the explicit erasure
  operation, authorization policy, and verification.
- Add inverse metadata actions where product UX permits them.
- Exercise large-Revision migration and repair benchmarks.
- Complete operator, privacy, and retention documentation.

## §17 Resolved decisions and open questions

### §17.1 Resolved decisions

1. Metadata and lifecycle events use a separate append-only
   PageHistoryEvent collection.
2. Revision remains content-only; metadata-only Revision rows are prohibited.
3. The first release includes the bounded outbox and repair path.
4. Content restore remains body-only.
5. Hard delete writes a path-keyed `PageDeletionRecord` in its own collection,
   retained indefinitely, with erasure as an explicit administrative
   operation rather than a timer. Paths are reused, so a Page-keyed or
   expiring record would lose the answer exactly when it is asked. Its state
   machine, authorization boundary, erasure operation, and verification ship
   together in Phase 4.
6. Ordinary visibility history contains grant enum before/after only.
7. Page-local historySequence is normative and existing content Revisions are
   migrated.
8. Event payload and operation-group schema is complete from the first release;
   UI exposure may be phased.
9. The API merges sources server-side behind one total-order cursor and does
   not write during a GET.
10. Historical metadata changes are not backfilled.
11. Path-reserving operations vacate a path before another Page may occupy it,
    never the reverse; the brief unoccupied window is inherent to standalone
    MongoDB, is already present today, and is handled by completing the
    operation with `redirectCreated: false` rather than by trying to eliminate
    it (§6.2a).
12. `operationId` is nullable on content rows. Only events, which are always
    created by a command, always carry one.
13. The recovery identity for a path-reserving command is the client-generated
    `Idempotency-Key`, required from the first attempt. The returned retryToken
    is a convenience and is never the sole means of resuming.
14. The sequence migration is operator-triggered and must not overlap a rolling
    deploy. A replica predating the tracking predicate cannot be fenced, so the
    residual risk is made detectable and repairable instead of being asserted
    away (§13.2a).
15. This RFC changes where metadata changes are recorded. It does not add
    throttling to visibility changes and does not narrow what a page path may
    contain; both would be separate product decisions, and the latter would make
    existing Pages unrecordable.

### §17.2 Residual open questions

1. **Sequence migration batch threshold.** The migration is correct per Page
   and may be staged, but Phase 2 must measure production-scale Revision
   counts and pin batch size, pause/resume limits, and the threshold at which a
   staged rollout is mandatory.

This question does not change the event schema, outbox protocol,
authorization boundary, body-only restore rule, or server-merged API.

## §18 Future work

- A separate tenant-wide administrative audit store with its own retention,
  search, export, and detailed ACL-change policy.
- Attachment and restricted-link security events in the administrative audit
  domain.
- Richer subtree operation presentation and operator inspection.
- Explicit content-restore provenance that does not alter Revision's
  content-only meaning.
- Read/unread cursors that distinguish content revisions from metadata events.
- Retention classes beyond live-page history and deletion records.

## §19 References

- [MediaWiki Manual: Null revision](https://www.mediawiki.org/wiki/Manual:Null_revision)
- [MediaWiki Manual: Logging table](https://www.mediawiki.org/wiki/Manual:Logging_table)
- [MediaWiki Manual: Reverts](https://www.mediawiki.org/wiki/Manual:Reverts)
- [MediaWiki Manual: Page moving](https://www.mediawiki.org/wiki/Manual:Page_moving)
- [Confluence: Auditing in Confluence](https://confluence.atlassian.com/doc/auditing-in-confluence-829076528.html)
- [CONFSERVER-24547: Please show title change history when viewing page history](https://jira.atlassian.com/browse/CONFSERVER-24547)
- [Confluence: Page History and Page Comparison Views](https://confluence.atlassian.com/doc/page-history-and-page-comparison-views-139379.html)
- [Git diffcore rename detection](https://git-scm.com/docs/gitdiffcore)
- [DokuWiki move plugin](https://www.dokuwiki.org/plugin:move)
- [Martin Fowler: Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)
- `packages/api/src/models/page.ts`
- `packages/api/src/models/revision.ts`
- `packages/api/src/models/activity.ts`
- `packages/api/src/events/page.ts`
- `packages/api/src/hono/handlers/page.ts`
- `packages/api/src/hono/handlers/revision.ts`
- `packages/collab/src/save-flow.ts`
- `packages/web/src/components/page-history/`
- `packages/api-contract/src/schemas/revision.ts`
- `docs/rfcs/0003-realtime-collaborative-editing.md`
- `docs/rfcs/0008-migration-framework.md`
- `docs/rfcs/0009-revision-storage-compaction.md`
- `docs/rfcs/0017-collab-invalidate-on-rename-delete.md`
- `docs/rfcs/0018-quoted-page-comments.md`
