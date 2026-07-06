# RFC-0017: Live collab editor invalidation on rename and delete

- **Status**: Draft
- **Author**: @sotarok
- **Created**: 2026-07-05
- **Depends on**:
  - RFC-0003 (Realtime Collaborative Editing) — this RFC extends the same
    Hocuspocus/Yjs editing model and reuses the already-landed in-process
    external-edit invalidation mechanism rather than adding a second editor
    transport.
  - RFC-0005 (Page Presence) — the Phase 2 cross-replica prompt fanout should
    follow the existing Redis pub/sub model where each API process owns local
    sockets and Redis carries events between replicas.
  - `packages/collab/src/invalidation.ts` — the G1 invalidation module already
    declares `page-body-replaced`, `page-renamed`, and `page-deleted` reason
    codes (`invalidation.ts:39`) and performs the force-reload broadcast and
    doc-base tombstone. This RFC requires fixing its dependency-compatible
    connection drain before rename/delete reuse, because the current
    registry-detach ordering prevents `Hocuspocus.closeConnections(pageId)`
    from seeing the detached document. Note the invalidator remains the
    best-effort *prompt/drain* transport; correctness is owned by the epoch
    (§4), not by the drain timing.
- **Related**:
  - `packages/api/src/models/page.ts` — page rename, soft delete, hard delete,
    and revert lifecycle methods are model-level operations, not only handler
    concerns. This RFC adds a `collabLifecycleVersion` field to the Page model
    and advances it ATOMICALLY — in the SAME `updateOne` that performs the
    mutation — on every collab-relevant lifecycle transition.
  - `packages/api/src/hono/handlers/page-collab.ts`,
    `packages/api/src/util/ws-token.ts`, and
    `packages/collab/src/hooks/on-authenticate.ts` — the token mint / verify
    and WebSocket gates for live collab sessions. This RFC signs the page's
    `collabLifecycleVersion` into the wsToken at mint and refuses a token whose
    epoch no longer matches the page at `onAuthenticate`, so a stale
    pre-transition token can never re-open or re-attach to a document.
  - `packages/collab/src/save-flow.ts` — the canonical write path for a live
    Y.Doc. This RFC folds the collab lifecycle EPOCH into the FINAL atomic
    compare-and-set that already commits the page pointer (`save-flow.ts:385-395`),
    so a save rendered from a now-stale lifecycle state is rejected at the
    durable DB write on every replica, not merely by a pre-render check.

## §0 Summary

Rename and delete operations must invalidate any live collaborative editor that
is currently attached to the affected page, and — more importantly — must make
it impossible for that stale editor to persist content into the renamed or
deleted page, or to resurrect deleted-era content on revert. Crowi already has
most of the *prompt* transport for this class of event:
`packages/collab/src/invalidation.ts:39` declares `page-renamed` and
`page-deleted`, and the invalidator broadcasts `crowi:force-reload`, tombstones
the page's doc base, and detaches the stale Hocuspocus document
(`invalidation.ts:160-231`). But the prompt/drain machinery is best-effort and
process-local; it is not the correctness boundary. This RFC makes correctness
rest on a single, cross-replica, tamper-proof authority: a **collab lifecycle
epoch**.

### §0.1 Why a lifecycle epoch (and why a path/status CAS is not enough)

The obvious-looking narrow fix — fold a `status: { $ne: STATUS_DELETED }`
predicate and a `path: <path this replica recorded at load>` predicate into the
atomic pointer CAS — is **self-invalidating** and does NOT close the hole (this is
recorded as a rejected alternative in §14.3a):

- `expectedPath` would be recorded by `onLoadDocument` from whatever the page row
  says AT LOAD TIME (`on-load-document.ts:242`). A stale wsToken (the JWT is 5
  minutes long, `ws-token.ts:23`, and carries only `{ userId, pageId, readonly,
  iat, exp }` — `api-contract/src/schemas/collab.ts:89-95` — with NOTHING that ties
  it to a pre-rename lifecycle state) can reconnect AFTER a rename. That reconnect
  triggers a fresh `onLoadDocument`, which reads and records the **POST-rename**
  path as `expectedPath`. The CAS then compares that post-rename `expectedPath`
  against the (still post-rename) row → they match → the stale editor's save lands
  in the renamed page. The path predicate compares new-vs-new and passes.
- The same defeat applies to ANY value recorded at load: the recording point is
  downstream of the transition, so a reconnect after the transition captures the
  post-transition value and the guard silently passes.

The correct authority is a value that (a) advances at the transition, (b) is
minted INTO the token BEFORE the transition, and (c) is checked at the earliest
materialization boundary — so a token issued before the transition is refused
before it can trigger a post-transition load. That value is the epoch.

**The `collabLifecycleVersion` epoch.** This RFC adds a monotonic integer
`collabLifecycleVersion` (default `0`) to the Page model (`page.ts`). Every
collab-relevant lifecycle transition ADVANCES it ATOMICALLY, in the SAME
`updateOne` that performs the mutation:

- rename (path change) — folded into `updatePageProperty`'s `updateOne`
  (`page.ts:1118-1120`, driven by `Page.rename` at `page.ts:1431`);
- soft delete (`STATUS_DELETED` write, `page.ts:1302`);
- hard delete / `removePage` (`page.ts:1372`) and draft cancel;
- revert (`page.ts:1332`, `page.ts:1336`);
- external body replace (`Page.updatePage`, `page.ts:1249-1253`) — so a
  body-replaced doc is also caught by the epoch, subsuming the existing
  `page-body-replaced` doc-base mechanism.

The epoch is then enforced at four boundaries, each reading shared Mongo state so
it holds on every replica:

1. **Token mint** signs the page's current `collabLifecycleVersion` into the
   wsToken (`page-collab.ts:88-92` via `ws-token.ts`).
2. **`onAuthenticate`** refuses a token whose `epoch !== page.collabLifecycleVersion`
   (`on-authenticate.ts:157-169`). A stale pre-transition token is rejected
   BEFORE any `onLoadDocument` runs, so it can never record a post-transition
   baseline. The client reconnects, the api mints a FRESH token carrying the new
   epoch, and the fresh load materializes the new canonical state. This is the
   structural fix the path-CAS lacked. The existing draft gate and the new
   deleted-status gate (§5) still apply to fresh tokens.
3. **Persistence writes become CONDITIONAL on the epoch.** `onChange` tags each
   `PageYjsUpdate` row with the epoch and refuses to append when the in-memory
   doc's epoch is stale; `onLoadDocument` replays ONLY rows whose
   `epoch === page.collabLifecycleVersion`; `persistYjsState` and compaction
   write with `updateOne({ _id, collabLifecycleVersion: epoch }, …)` so a
   stale-epoch checkpoint cannot land.
4. **`executeSave`** folds the epoch into the atomic pointer CAS:
   `{ _id, currentRevision, collabLifecycleVersion: expectedEpoch, status: { $ne:
   STATUS_DELETED } }` (§4.1, current CAS at `save-flow.ts:385-395`). A save
   carrying a stale epoch is rejected at the durable write, on whichever replica
   handles it.

`onLoadDocument` records the page's current epoch server-side, process-local,
UNCONDITIONALLY at load (in the same sibling-structure discipline the earlier
draft required for the path — a `Map` keyed by `documentName` written before the
drain-sentinel branch, `on-load-document.ts:265-270`, so a doc materializing
mid-drain still has its epoch recorded) and materializes the doc with it. Because
the epoch is minted into the token and checked at `onAuthenticate`, a stale
reconnect is refused before load — so unlike the path, the epoch a load records
is always the epoch the token was authorized against.

This epoch model SUBSUMES the path/status CAS: the epoch advances on ANY collab
lifecycle transition, not just a path change, so it detects rename, soft delete,
hard delete, draft cancel, revert, AND body-replace with one predicate. The
status/path predicates MAY be kept in the CAS as complementary defense-in-depth
(a `status: { $ne: STATUS_DELETED }` predicate is cheap and makes the deleted
case explicit), but the EPOCH is the authority that closes the stale-token and
stale-state holes. Because a stale-epoch `PageYjsUpdate` row and a stale-epoch
`yjsState` checkpoint are already non-replayable, the soft-delete lineage purge
and the revert re-purge (§7) become DEFENSE-IN-DEPTH cleanup, and correctness no
longer depends on drain timing.

### §0.2 The two failure classes the epoch closes

1. **Stale write into a renamed/deleted page (all replicas, no TOCTOU).** A
   normal rename changes only the page `path` (`Page.rename` writes `updateData =
   { path, lastUpdateUser, ...updatedAt }` at `page.ts:1428,1431`) and a soft
   delete only writes `status: STATUS_DELETED` (`page.ts:1302`); NEITHER moves
   `currentRevision`, so the existing `{ _id, currentRevision }` lock
   (`save-flow.ts:385-386`) still matches and a stale editor on ANY replica can
   save. `executeSave` also renders BEFORE the CAS (`Revision.prepareRevision`
   persists `renderedAst`, `revision.ts:346`, `save-flow.ts:344`), so a lifecycle
   mutation landing between a pre-render check and the CAS is a genuine TOCTOU. By
   advancing `collabLifecycleVersion` in the SAME `updateOne` as the mutation and
   putting `collabLifecycleVersion: expectedEpoch` in the atomic CAS, the stale
   save misses the row at the durable write — cross-replica, with no TOCTOU
   window, and additionally the stale token/reconnect is refused at
   `onAuthenticate` before it ever loads.

2. **Revert resurrects deleted-era collab state.** Soft delete keeps the same
   `_id` and does NOT clear `yjsState`/`yjsCheckpointAt` or delete the page's
   `PageYjsUpdate` rows. `onLoadDocument` restores `yjsState`
   (`on-load-document.ts:281`) and replays `PageYjsUpdate`
   (`on-load-document.ts:422`), so after `revertDeletedPage` flips the row back to
   published (`page.ts:1332,1336`) a fresh load reconstructs the stale
   deleted-era Y.Doc. Under the epoch, the revert advances
   `collabLifecycleVersion`, so the pre-revert `yjsState` checkpoint and the
   deleted-era `PageYjsUpdate` rows carry a now-stale epoch and are NON-REPLAYABLE
   by `onLoadDocument` — the load body-seeds from the reverted revision. The
   boundary purge (§7.1) and the revert re-purge (§7.4) remain as
   defense-in-depth cleanup of the now-inert rows.

The existing API-side shim in `page.ts:290-295` hardcodes only
`page-body-replaced`, and `updatePage` is the only committed path that drives it
after a body write (`page.ts:1280,1293`).

This RFC makes rename/delete part of the same lifecycle contract:

1. **Collab lifecycle epoch (the correctness authority).** Add
   `collabLifecycleVersion` to the Page model, advance it atomically on every
   collab-relevant transition, sign it into the wsToken, enforce it at
   `onAuthenticate`, tag/filter `PageYjsUpdate` and `yjsState` by it, and fold it
   into the atomic save CAS. This lives in shared Mongo, so it is cross-replica
   safe (§4).
2. **Dependency-compatible invalidator drain.** Before `page-renamed` or
   `page-deleted` can reuse the invalidator, it must stop relying on
   `closeConnections(pageId)` after registry deletion. It must retain a tested
   drain path for the captured Hocuspocus document and preserve the sentinel doc
   base until stale sockets are actually closed or abandoned. This is the
   *prompt/drain* mechanism only; the epoch, not the drain, is the write
   authority.
3. **Lifecycle-transition invalidation + epoch advance.** A user-facing rename
   advances the epoch and emits `page-renamed` once the page path is durably
   changed. A soft delete advances the epoch and emits `page-deleted` once
   `STATUS_DELETED` is durably written. A hard delete or draft cancel advances the
   epoch and emits `page-deleted` once the target page row is durably removed.
   Non-deletable validation failures emit nothing and advance nothing; later
   cleanup failures after a durable lifecycle transition do not suppress
   invalidation.
4. **Deleted-page materialization gates.** Deleted pages become unavailable to
   collab at token issuance, WebSocket authentication, and document load, so a
   deleted `_id` can neither mint a new token nor re-materialize a Y.Doc — on top
   of the epoch check.
5. **Collab-lineage purge on delete (defense-in-depth).** Soft delete, hard
   delete, and draft cancel purge the page's `yjsState`/`yjsCheckpointAt` and its
   `PageYjsUpdate` append rows, so cancelled/deleted content is not recoverable
   from the append log and revert cannot resurrect a stale deleted-era checkpoint
   even if a stale-epoch row were somehow replayed.
6. **Model-level rename/delete contract.** `Page.rename`, `Page.renameTree`,
   `Page.deletePage`, `Page.completelyDeletePage`, `Page.removePage`, and their
   `ById` / `ByPath` wrappers own typed emit/skip semantics AND the atomic epoch
   advance so every mutation path has explicit lifecycle behavior. Revert and
   user-activation repair paths advance the epoch (to invalidate stale state) but
   explicitly skip user-facing force-reload prompts.
7. **Existing editor UX.** The web editor keeps the current reload prompt flow.
   It does not auto-reload, redirect, or silently merge stale Y.Doc content.

The multi-replica PROMPT — telling an editor on *another* replica to reload — is
still deferred to Phase 2 (Redis fanout, §9). But with the epoch in the atomic
CAS and in `onAuthenticate`, that editor's next save is rejected at the durable
write on whichever replica handles it (the CAS reads the freshly-mutated
canonical row's epoch), and its next reconnect is refused until it mints a fresh
token — so it can no longer WRITE anything harmful or resurrect stale state before
it reloads; the deferred piece is purely the courtesy prompt, not correctness.

## §1 Background / Motivation

Crowi's collaborative editor keeps a live Hocuspocus Y.Doc in memory. External
page body writes already need special handling because a persisted revision can
move while that live document is still serving old content. The G1
editor-preview-reliability work solved that for body replacement:

- the invalidation module documents itself as single-instance external-edit
  invalidation (`packages/collab/src/invalidation.ts:6-35`);
- it defines the complete reason space, including rename and delete
  (`invalidation.ts:39`);
- it tombstones the doc base before broadcasting so stale saves conflict
  (`invalidation.ts:160-175`);
- it detaches the stale Hocuspocus document from the registry before the drain
  window, forcing reconnects through a fresh load path (`invalidation.ts:180-199`);
- it currently schedules `closeConnections(pageId)` after the detach
  (`invalidation.ts:212-226`), but that close path is ineffective for the
  detached document because Hocuspocus resolves connections through
  `this.documents`. Fixing that drain path is part of this RFC.

The API currently uses that mechanism only for body replacement. The helper in
`packages/api/src/models/page.ts:290-295` always emits `page-body-replaced`, and
`Page.updatePage` calls it only after the revision has been pushed and the page
event emitted (`page.ts:1280,1293`). Rename and delete operations can therefore
leave an editor attached to a stale document until a later save, reconnect, or
conflict reveals the problem.

### §1.1 Why body-replace's protection does not cover rename

Body replacement is safe against stale saves today because `Page.updatePage`
nulls `yjsState` and bumps `currentRevision`
(`page.ts:1284-1293` comment describes this), which invalidates save-flow's
compare-and-set: the doc base recorded in `onLoadDocument`
(`on-load-document.ts:266-267`) no longer equals the live `currentRevision`, so
both `save-flow.ts:297` and the CAS at `save-flow.ts:385-386` reject the stale
save.

Rename is different. `Page.rename` updates `updateData = { path, lastUpdateUser,
...updatedAt }` (`page.ts:1428`) via `updatePageProperty`
(`page.ts:1431`) and updates the revision documents' `path`
(`Revision.updateRevisionListByPath` at `page.ts:1433`). It never touches
`currentRevision` or `yjsState`. So a live editor's doc base still equals the
page's live `currentRevision` after the rename, and its save passes every
existing lock and lands in the renamed page. This is the core reason DECISION 1
introduces the **collab lifecycle epoch**: the rename advances
`collabLifecycleVersion` in the SAME `updateOne` that changes `path`
(`page.ts:1118-1120`), so the durable pointer CAS — which now carries
`collabLifecycleVersion: expectedEpoch` — misses the row, and the stale token is
additionally refused at `onAuthenticate` before it can even reload. A guard that
merely records the page's *path* at load cannot do this: a stale token that
reconnects after the rename records the post-rename path, so a path predicate
compares new-vs-new and passes (§0.1). The epoch closes that hole because it is
minted into the token BEFORE the transition and checked at the earliest
materialization boundary.

### §1.2 Why delete is more than a missing prompt

A soft delete keeps the same page `_id`, marks the page `STATUS_DELETED`, removes
share data, and renames the path under `/trash/`
(`packages/api/src/models/page.ts:1297-1310`). The current by-id grant loader
checks drafts and grants but not deleted status, the Yjs-token handler mints
tokens after that loader and only rejects another user's draft
(`packages/api/src/hono/handlers/page-collab.ts:70-84`), WebSocket authentication
loads `_id status creator` and rejects missing pages or foreign drafts but not
deleted pages (`packages/collab/src/hooks/on-authenticate.ts:154-169`), and save
flow rejects missing pages but not deleted pages
(`packages/collab/src/save-flow.ts:264-269`). So `page-deleted` invalidation must
be paired with the epoch advance AND deleted-status gates AND a collab-lineage
purge. The epoch is the primary authority — a soft delete advances
`collabLifecycleVersion`, so a stale token minted before the delete is refused at
`onAuthenticate` (its epoch no longer matches) and an already-open socket's save
misses the atomic CAS (its `collabLifecycleVersion` predicate no longer matches).
The deleted-status gates (§5) are complementary belt-and-suspenders on the same
boundaries, and the lineage purge (§7) is defense-in-depth cleanup of the
now-stale-epoch (already non-replayable) `yjsState`/`PageYjsUpdate` rows so
`revertDeletedPage` cannot re-expose the deleted `_id`'s live collab state.

## §2 Goals / Non-Goals

### §2.1 Goals

- Introduce a **collab lifecycle epoch** (`collabLifecycleVersion` on the Page
  model) as the cross-replica, tamper-proof authority for collab write-safety and
  state invalidation. Advance it ATOMICALLY, in the same `updateOne` as the
  mutation, on rename, soft delete, hard delete, draft cancel, revert, and
  external body replace.
- Sign the epoch into the wsToken and reject a token whose epoch no longer
  matches the page at `onAuthenticate`, so a stale pre-transition token can never
  trigger a post-transition load or re-attach.
- Make the collab WRITE path reject stale saves after ANY lifecycle transition on
  **every replica**, at the durable write, by folding
  `collabLifecycleVersion: expectedEpoch` into the ATOMIC pointer CAS (§4.1),
  leaving no TOCTOU gap between pre-check and commit. Keep a
  `status: { $ne: STATUS_DELETED }` predicate as complementary defense.
- Make `PageYjsUpdate` appends and `yjsState`/checkpoint writes CONDITIONAL on
  the epoch: tag append rows with the epoch, replay only current-epoch rows, and
  write checkpoints with an `collabLifecycleVersion: epoch` filter, so
  stale-epoch collab state is non-replayable and stale checkpoints cannot land.
- Reuse the G1 in-process invalidation mechanism for the `page-renamed` /
  `page-deleted` reload PROMPT only after fixing its connection drain so registry
  detach does not make stale sockets unreachable — the prompt is UX, not the
  write authority.
- Emit rename/delete reload prompts (and advance the epoch) after the first
  durable lifecycle transition that makes the live editor stale or unavailable:
  page path update for rename, `STATUS_DELETED` write for soft delete, and
  page-row removal for hard delete or draft cancel.
- Reject deleted pages at every live-collab *materialization* boundary:
  Yjs-token issuance, WebSocket authentication/reconnect, and `onLoadDocument`
  (complementary to the epoch check).
- Purge collab lineage (`yjsState`/`yjsCheckpointAt` + `PageYjsUpdate` rows) at
  the soft-delete, hard-delete, and draft-cancel boundaries, and re-run an
  idempotent purge in `revertDeletedPage` — as defense-in-depth cleanup of the
  now-stale-epoch (already non-replayable) rows, and to sweep pre-RFC
  already-deleted rows that predate the epoch field.
- Define a typed model-level invalidation contract for `Page.rename`,
  `Page.renameTree`, `Page.deletePage`, `Page.completelyDeletePage`,
  `Page.removePage`, and the `ById` / `ByPath` removal wrappers, including the
  atomic epoch advance and explicit skip semantics for internal repair paths
  (skip = suppress the user-facing prompt, NOT skip the epoch advance).
- Cover every current rename/delete surface:
  - single-page rename handler calling `Page.rename`
    (`packages/api/src/hono/handlers/page.ts:960-968`);
  - subtree rename handlers and `Page.renameTree`
    (`packages/api/src/models/page.ts:1478-1508`);
  - soft delete inside the `isDeletable` guard
    (`packages/api/src/models/page.ts:1297-1313`);
  - hard delete (`page.ts:1344-1364`);
  - draft cancel through `Page.removePage`
    (`packages/api/src/hono/handlers/draft.ts:217`);
  - `revertDeletedPage` (`packages/api/src/models/page.ts:1315-1339`);
  - redirect-origin cleanup through `Page.removeRedirectOriginPageByPath`
    (`packages/api/src/models/page.ts:1403-1419`).
- Preserve the current web UX: a force-reload dialog with recovery-buffer
  handling, not automatic reload.
- Document the Phase-2 Redis fanout follow-up required for the multi-instance
  *prompt* (write-safety is already closed everywhere by the epoch).

### §2.2 Non-Goals

- Viewer-side page content synchronization. A future `page-updated` viewer
  banner/fanout layer is separate from editor Y.Doc invalidation.
- Renderer, attachment, or markdown cache invalidation.
- Silent merge of stale Y.Doc content after a page lifecycle mutation.
- Automatic redirect after rename or automatic reload after delete.
- A DB read from Hocuspocus `beforeHandleMessage` for every inbound frame. Write
  correctness is enforced by the epoch at the save-flow CAS (§4.1) and at
  `onAuthenticate`, not per-frame.
- Cross-replica Redis delivery of the reload PROMPT in Phase 1. Multi-replica
  prompt delivery is documented as a known limitation and Phase-2 work.
  Multi-replica WRITE safety is NOT deferred — it is closed by the epoch (§4) in
  Phase 1.

## §3 Existing Mechanism To Reuse And Fix

The existing invalidator is the correct transport shape for the reload PROMPT,
but its drain implementation must be fixed before rename/delete relies on it. It
is deliberately best-effort and non-blocking: `PageInvalidator.invalidatePages`
returns a promise but the contract says failures must not propagate into the
write that triggered invalidation (`packages/collab/src/invalidation.ts:104-110`).
Its implementation also catches per-page failures and clears tombstones
defensively (`invalidation.ts:227-231`).

The required invalidator behavior is:

- mark `docBaseRevisions` with `INVALIDATED_DOC_BASE` (`invalidation.ts:92,167`)
  and mark `invalidatedPages` before any client-visible signal;
- broadcast `crowi:force-reload` to the captured Hocuspocus document when one
  exists;
- force-close or abandon the **captured document's actual connections** through
  a dependency-compatible path. The implementation may close the captured
  document's connections directly, or reorder the operation so
  `instance.closeConnections(pageId)` runs while the document is still present
  in `instance.documents`; it must not call `closeConnections(pageId)` only
  after deleting the registry entry;
- keep the invalidated doc-base sentinel owned by the invalidator until stale
  connections are closed/abandoned. A later fresh `onLoadDocument` must not be
  able to overwrite the sentinel with the current live revision while a stale
  detached socket can still save (`on-load-document.ts:265-270` already guards
  this by leaving the sentinel in place while `isInvalidating` is true);
- delete or otherwise prevent re-attachment to the stale document before any
  new connection can reuse it through Hocuspocus's existing-document fast path;
- include a regression test that proves a document detached from
  `instance.documents` still has its stale connections closed, or that detach
  happens only after the close path has already reached those connections.

API callers should keep using `crowi.collabAttachment.invalidatePages(...)`.
The attachment is installed by `packages/api/src/collab/attach.ts`, which
creates the collab server and returns a small API containing `invalidatePages`
(`attach.ts:367-369`) and `shutdown`. The current body-replace shim in `Page`
should be generalized from:

- `invalidateLiveCollabDoc(pageId)` with hardcoded `page-body-replaced`
  (`packages/api/src/models/page.ts:290-295`)

to:

- `invalidateLiveCollabDoc(pageIds, reason)` or an equivalent typed helper that
  accepts `InvalidateReason` (the union `'page-body-replaced' | 'page-renamed'
  | 'page-deleted'` already exists at `invalidation.ts:39`) and still swallows
  missing attachment / failure.

The web payload can remain the existing stateless message shape. The client
already listens for `kind: 'crowi:force-reload'` and accepts a reason string;
the schema does not need to become an enum unless implementation chooses to
formalize reason codes in `@crowi/api-contract`.

## §4 Write-Safety Model (cross-replica, epoch-based)

The reload prompt is a courtesy; the correctness guarantee is that a stale
editor **cannot persist into a renamed or deleted page**, and **cannot resurrect
deleted-era collab state on revert**, regardless of which replica it is connected
to. The authority for that guarantee is the **collab lifecycle epoch**
(`collabLifecycleVersion`), a monotonic integer on the Page model that advances
atomically on every collab-relevant lifecycle transition and is enforced at four
boundaries against the canonical Mongo row every replica shares.

### §4.0 The epoch field and its atomic advance

`collabLifecycleVersion` is a `Number` on the Page schema (`page.ts`), default
`0`, monotonically increasing. It is advanced ATOMICALLY WITH the lifecycle
mutation — for the `updateOne`-based paths (rename / soft delete / revert) with
`$inc: { collabLifecycleVersion: 1 }` in that same `updateOne`, and for the
`pageData.save()`-based body-replace path by setting the field on the doc before
the single save — so a reader never observes the mutated row at the old epoch:

- **Rename** — folded into `updatePageProperty` (`page.ts:1118-1120`), which
  `Page.rename` calls to change `path` (`page.ts:1431`). The lifecycle callers
  (§6) pass a flag so the `$inc` rides the same `updateOne` as the `path` write.
- **Soft delete** — the `updatePageProperty(pageData, { status: STATUS_DELETED,
  … })` call at `page.ts:1302` also `$inc`s the epoch.
- **Hard delete / draft cancel** — the page row is physically removed
  (`page.ts:1357` / `page.ts:1372`); the epoch of a removed row is moot for the
  CAS (the `_id` no longer exists, so any CAS misses), but any still-attached
  socket's in-memory epoch is stale relative to "no row", and the `onChange`
  epoch guard (below) plus row removal stop further appends.
- **Revert** — the `updatePageProperty(pageData, { status: STATUS_PUBLISHED, …
  })` at `page.ts:1332` and the internal rename at `page.ts:1336` each `$inc` the
  epoch, so the pre-revert `yjsState`/`PageYjsUpdate` (deleted-era) carry a stale
  epoch and are non-replayable by the load that materializes the reverted page.
- **External body replace** — `Page.updatePage` already nulls `yjsState` and
  bumps `currentRevision` via `pushRevision` (`page.ts:1249-1253`). Unlike the
  other paths, `pushRevision` persists through `pageData.save()` (`page.ts:1168`),
  not `updateOne`, so the epoch is bumped by setting `pageData.collabLifecycleVersion`
  before that save. NOTE that this per-doc `save()` is a read-modify-write, not an
  atomic `$inc`, so a concurrent epoch increment (e.g. a simultaneous rename's
  `$inc`) could be lost on this path. That is NOT a correctness hole here because
  body-replace ALSO moves `currentRevision`, so the existing `{ _id,
  currentRevision }` CAS backstops it independently of the epoch — the epoch is
  belt-and-suspenders on this one path, not the sole guard: the body replace's
  `currentRevision` move is caught by the existing doc-base lock (the original
  `page-body-replaced` mechanism). Advancing the epoch here means the body-replace
  case is covered by the SAME uniform machinery as rename/delete (and it
  generalizes the `invalidateLiveCollabDoc` prompt call at `page.ts:1280,1293`).

Rename, soft delete, and revert advance the epoch in the SAME `updateOne` as the
field they guard (`updatePageProperty` is a direct `updateOne`, `page.ts:1118-1120`).
Because model methods are NOT transactional (§7.5), that co-located `$inc` is what
makes a partial mutation write-safe: the instant `status`/`path` is durable, the
epoch has ALSO moved, so a later step in the same method throwing cannot leave the
row at a matchable epoch. The body-replace path relies on `currentRevision` +
epoch both moving in the one `pageData.save()`.

### §4.0.1 All persistence funnels through guarded write paths

All canonical persistence for a live Y.Doc funnels through `save-flow.ts`'s
`executeSave` (the Revision write at `save-flow.ts:355-360` and the pointer CAS
at `save-flow.ts:385-395`). `onChange` (`on-change.ts:77`) and `onStoreDocument`
(`on-store-document.ts:100`) only append/checkpoint intermediate Yjs state; they
never create a canonical Revision. The epoch is threaded through ALL of these:
the atomic save CAS (§4.1), the `onChange` append + `onLoadDocument` replay
(§4.2), and the `persistYjsState`/compaction checkpoint (§4.2).

### §4.1 The epoch folded into the atomic pointer CAS

The existing durable write is a single conditional `updateOne`
(`save-flow.ts:385-395`):

```ts
Page.updateOne(
  { _id: pageId, currentRevision: docBaseFilterValue },     // today's server-doc lock
  { $set: { revision, currentRevision, lastUpdateUser, updatedAt } },
);
```

`executeSave` already loads the page fresh at the top of the save
(`save-flow.ts:253`, `Page.findById(pageId)`), rejects a missing page with
`PAGE_NOT_FOUND` (`save-flow.ts:264-266`), and does an early fail-fast doc-base
divergence read (`save-flow.ts:294-303`). None of those pre-checks is the
authority: between the page load and the pointer write, `executeSave` renders
the body (`Revision.prepareRevision`, `save-flow.ts:344`) and saves the Revision
(`save-flow.ts:355-360`). `Revision.prepareRevision` PERSISTS renderer output to
`renderedAst` (`revision.ts:346`), and the web render path emits raw
markdown-embedded HTML with no `rehype-sanitize`
(`render-mdast.ts:166,180`, §13). A rename or soft delete that commits AFTER a
stale save was loaded but BEFORE its CAS runs is a genuine TOCTOU: a pre-render
guard would have already passed. So the guard MUST be part of the final atomic
filter, not a separate earlier check.

This RFC therefore extends the CAS filter with the epoch (plus a complementary
deleted-status predicate):

```ts
Page.updateOne(
  {
    _id: pageId,
    currentRevision: docBaseFilterValue,        // existing body/concurrency lock
    collabLifecycleVersion: expectedEpoch,       // THE lifecycle authority
    status: { $ne: STATUS_DELETED },             // complementary defense
  },
  { $set: { revision, currentRevision, lastUpdateUser, updatedAt } },
);
```

1. **Epoch predicate (`collabLifecycleVersion: expectedEpoch`) — the authority.**
   `expectedEpoch` is the epoch THIS replica recorded when it materialized the
   document (§4.1.1). Every collab lifecycle transition advances the row's epoch
   in the same `updateOne` as the mutation (§4.0), so a rename, soft delete,
   revert, or body-replace makes the row's `collabLifecycleVersion` differ from
   the stale save's `expectedEpoch`, and the CAS misses — regardless of whether
   the mutation moved `currentRevision`, `status`, or `path`. This is why the
   epoch subsumes the earlier path/status predicates: ONE integer detects ALL
   lifecycle moves the `{ _id, currentRevision }` pointer lock cannot see. Because
   the epoch is compared against the canonical Mongo row, a mutation on replica A
   is enforced by an `executeSave` on replica B.

2. **Deleted-status predicate (`status: { $ne: STATUS_DELETED }`) — complementary
   defense.** Soft delete writes `status: STATUS_DELETED` (`page.ts:1302`,
   `page.ts:15`) AND advances the epoch, so the epoch predicate alone already
   rejects a post-delete save. The status predicate is kept as an inexpensive,
   explicit belt-and-suspenders that also rejects any legacy pre-epoch
   soft-deleted row (whose `collabLifecycleVersion` may be absent / `0`) during
   the rollout window (§16 back-compat).

`expectedEpoch` is read from the same sibling structure that pins the doc base
context — recorded UNCONDITIONALLY at `onLoadDocument` (§4.1.1). When a load
recorded no epoch for this process (a synthetic test driver, or a process that
restarted since load — mirroring the existing `docBase === undefined` fallback at
`save-flow.ts:294`), the CAS omits the epoch predicate and relies on the
`{ _id, currentRevision }` + `status` predicates, exactly as the doc-base lock
degrades today; a restart cannot manufacture a *matching* stale epoch, so this
is fail-safe, not a hole. A brand-new page whose row predates the epoch field
reads `collabLifecycleVersion` as `undefined`; the migration (§16) backfills
existing rows to `0`, and the schema default is `0`, so a real page always has a
concrete epoch to match.

A zero-match on the CAS is already the "your document is stale, reload" outcome
(the existing `matchedCount === 0` path at `save-flow.ts:399-467`). The new
predicate folds cleanly into that same branch: a miss caused by a lifecycle
transition is surfaced as the same `CONFLICT` reload-required error the doc-base
lock produces (`save-flow.ts:466`). Note the existing branch runs a same-process
coalesce probe (`tryCoalesce`, `save-flow.ts:439-461`) — because a lifecycle
transition never advances the in-process `docBaseRevisions` base to the mutated
row, `tryCoalesce`'s "base advanced to live pointer" condition
(`save-flow.ts:196-205`) cannot hold, so a lifecycle-driven miss can never be
mis-coalesced into a false save-ok; it settles to `CONFLICT` after the bounded
retry budget.

The early doc-base pre-check (`save-flow.ts:294-303`) is KEPT as a fast-fail
(skip the renderer on an obvious divergence), but it is explicitly NOT the
lifecycle authority. The epoch predicate on the atomic CAS is.

This closes rename/delete/revert WRITE correctness cross-replica in Phase 1 (see
§9 for how this makes the multi-replica case safe even before the Phase-2 prompt
fanout). The `{ _id, currentRevision }` portion remains the concurrency lock for
*body* co-editing; the epoch predicate handles every *lifecycle* move.

#### §4.1.1 The expected epoch is server-recorded, per-replica, and stored where the drain sentinel cannot hide it

`expectedEpoch` MUST be recorded server-side, at each replica's own
`onLoadDocument`, from the page row that replica read. It is NOT client-supplied.
Unlike a client-supplied value, the epoch cannot be smuggled past the guard by a
stale client — but the deeper reason the *server*-recorded epoch is safe where a
server-recorded *path* was not is the token gate: a stale token is refused at
`onAuthenticate` (§5) because its epoch no longer matches the row, so it never
reaches `onLoadDocument` to record a post-transition epoch in the first place. A
path recorded at load had no such upstream gate (the token carried no path), which
is exactly why a post-rename reconnect could record the post-rename path and
defeat the path-CAS (§0.1). The epoch is recorded at load AND authorized at the
token boundary; the path was only recorded at load.

The recording point already exists: `onLoadDocument` reads the page row
(`on-load-document.ts:242`) and will additionally select `collabLifecycleVersion`
and `status` (§5). The critical storage constraint is that the recorded epoch
must live in a structure populated at EVERY load, regardless of the invalidation
drain sentinel. Today the doc base is recorded conditionally — `onLoadDocument`
SKIPS `docBaseRevisions.set(...)` while a page is mid-drain
(`on-load-document.ts:265-270`), leaving the invalidator's sentinel base in place
so an in-flight stale save keeps conflicting. If `expectedEpoch` were stored in
that same conditional structure, a document that materializes DURING a drain
would have no recorded epoch, the epoch predicate would be built from an absent
value, and the CAS would silently degrade to the doc-base-only lock — which a
rename does NOT trip. Therefore `expectedEpoch` MUST be recorded in a sibling
structure that `onLoadDocument` writes UNCONDITIONALLY at load (e.g. a `Map`
keyed by `documentName`, set on every load before the drain-sentinel branch),
independent of the `docBaseRevisions` skip. If a load resolves no epoch (a
synthetic driver, or a pre-migration row), the CAS omits the epoch predicate and
falls back to `{ _id, currentRevision }` + `status` — an absent recorded epoch is
never coerced into a *matching* value.

The exact TypeScript property/collection name for that sibling structure is a
phase-scoped naming detail (§16), but its lifecycle contract — recorded
server-side, unconditionally at load, per replica, read into the atomic CAS
filter — is fixed by this section and is NOT an open question.

### §4.2 `onChange` append and `onLoadDocument` replay are epoch-conditional; the checkpoint write is an epoch CAS

The intermediate Yjs-state paths are also made epoch-aware, so a stale-epoch
delta can never be appended, replayed, or checkpointed into an authoritative
lineage — this is what makes the soft-delete → revert resurrection structurally
impossible, rather than relying on drain-timed purges.

1. **`onChange` stamps the append (and MAY best-effort skip).** `onChange`
   appends a `PageYjsUpdate` row per delta with no Page model lookup today
   (`on-change.ts:68-81`, the `create` at `on-change.ts:77`). It now STAMPS each
   row with the epoch `onLoadDocument` recorded for this document at load time
   (the §4.1.1 sibling `Map`) — a value FIXED at load, not a live DB read.
   `onChange` CANNOT detect DB-epoch staleness process-locally on its own:
   knowing the page's *current* DB epoch would require the replica-local
   invalidator tombstone (same-replica only) or a Mongo read, and this RFC does
   NOT add a per-keystroke Mongo read (§2.2). So `onChange` MAY, as a
   best-effort optimization, skip the append when the replica-local invalidator
   has already tombstoned this document (`invalidatedPages`, i.e. an invalidation
   that ran on THIS replica) — but that is a courtesy to avoid writing rows a
   cross-replica reader will discard, not the correctness boundary. The TRUE
   correctness guarantee is the composition: STAMP (here) + REPLAY-FILTER
   (`onLoadDocument` replays only rows whose `collabLifecycleVersion ===
   page.collabLifecycleVersion`, below) + EPOCH-CAS (persist/save conditional on
   the epoch, §4.1 and §4.2 item 3). Under that composition, a keystroke during
   the ~1500ms invalidator drain (the doc is detached from the registry at
   `invalidation.ts:198` but sockets close only after `graceMs`,
   `invalidation.ts:102,217-226`) appends a row stamped with the LOAD-TIME epoch;
   once the page's epoch has advanced past that value, the row is simply not
   replayed and its checkpoint cannot land — regardless of whether `onChange`
   noticed the staleness. Correctness never rests on `onChange` "refusing when
   stale".

   Implementation notes for the wiring `onChange` requires:
   - The §4.1.1 sibling `Map` (keyed by `documentName`) MUST be CLEARED on
     document unload (`onDisconnect` / the Hocuspocus doc-destroy hook), or it
     leaks one entry per page materialized for the process lifetime. The
     `docBaseRevisions` store already has an unload-cleanup discipline; the
     epoch sibling `Map` follows the same lifecycle.
   - `onChange` today receives only `{ documentName, update, context }`
     (`on-change.ts:69`) and reaches no shared collab state. It needs NEW wiring
     to reach the §4.1.1 sibling `Map` (to read the load-time epoch it stamps)
     and — for the optional best-effort skip — the invalidator's
     `invalidatedPages` set. Both are threaded in through `OnChangeDeps`
     (`on-change.ts:26-29`) the same way `models` / `compactor` already are.

2. **`onLoadDocument` replays only current-epoch rows.** The residual-replay
   helpers (`replayResidualUpdates` at `on-load-document.ts:105-133`, and the
   time-gated `purgeStaleResidualUpdates` at `:168-184`) now additionally filter
   by `collabLifecycleVersion === page.collabLifecycleVersion`. A row whose epoch
   is behind the page's current epoch descends from a superseded lifecycle and is
   NOT applied (it may be swept, best-effort, like today's poisoned/stale rows).
   So even if a drain-window straggler was appended for a soft-deleted `_id`, a
   later `revertDeletedPage` — which advanced the epoch (§4.0) — makes that
   straggler's epoch stale, and the reverted page's load body-seeds from the
   reverted revision instead of replaying it. This closes the resurrection hole at
   the REPLAY boundary, independent of whether the boundary purge or the revert
   re-purge (§7) actually removed the row.

3. **`persistYjsState` / compaction become an epoch CAS.** `persistYjsState`
   currently writes with a filter of only `{ _id }` (`persist-yjs-state.ts:128`).
   It now writes with `{ _id, collabLifecycleVersion: expectedEpoch }` and treats
   a zero-match update as "do not persist" (return the existing `ok: false`-style
   no-write result) rather than resurrecting a checkpoint for a page whose epoch
   has moved. The compaction full-merge path routes through the same chokepoint,
   so a stale-epoch checkpoint can never overwrite `yjsState` after a lifecycle
   transition. A complementary `status: { $ne: STATUS_DELETED }` may be kept for
   legacy pre-epoch rows. This is a cheap conditional on an existing write, not a
   new per-frame read.

Because the epoch is minted into the token and checked at `onAuthenticate`, a
stale editor is normally torn down before it can even reach `onChange`. The
narrow drain-window race that remains — a still-attached socket appending during
the ~1500ms grace — is closed deterministically NOT by `onChange` detecting
staleness (it stamps a load-time epoch and cannot see the live DB epoch on its
own, above), but by the replay-filter (`onLoadDocument` skips stale-epoch rows)
and the checkpoint/save epoch-CAS, all of which read the canonical epoch without
a per-keystroke Mongo read.

The soft-delete boundary purge (§7.1) and the revert re-purge (§7.4) are RETAINED
as defense-in-depth cleanup — they keep the append log and `yjsState` small and
sweep pre-epoch legacy rows — but correctness no longer depends on their timing:
a stale-epoch row is non-replayable whether or not a purge has run yet.

#### §4.2.1 `PageYjsUpdate` gains an epoch field

`PageYjsUpdate` today stores `{ pageId, payload, createdAt }`
(`packages/api/src/models/page-yjs-update.ts:27-32,49-50`) with a `(pageId,
createdAt)` compound index and a 1-hour `createdAt` TTL. This RFC adds a
`collabLifecycleVersion: Number` field, stamped by `onChange` from the in-memory
doc's recorded epoch (§4.2). The replay query in `replayResidualUpdates`
(`on-load-document.ts:106`) and the purge scan in `purgeStaleResidualUpdates`
(`on-load-document.ts:172`) add `collabLifecycleVersion` to their projections and
filter/skip rows whose epoch is behind the page's current epoch. The existing
compound index still serves the chronological read; adding the epoch to the
projection is index-covered-agnostic (the rows are already fetched by `pageId`).

Existing `PageYjsUpdate` rows created before this field shipped have no
`collabLifecycleVersion`. They are treated as epoch `0` (a missing field compares
unequal to any positive current epoch, so they are simply not replayed once a
page's epoch has advanced; on a never-mutated page still at epoch `0` they replay
as before). No backfill of `PageYjsUpdate` is required because the TTL sweeps them
within an hour and the epoch treatment is fail-safe; §16 records this as a
documented rollout note.

## §5 Deleted-Page Materialization Gates (epoch-first)

The epoch is checked at the token/auth boundary, and deleted status is a
complementary access boundary for *materializing* a live Y.Doc, in addition to
the write-boundary epoch CAS of §4.1. Together these prevent a deleted `_id` — or
a stale pre-transition token for any page — from ever becoming a fresh editable
document again.

1. **Yjs-token issuance signs the epoch.** `GET /pages/{id}/collab/yjs-token`
   loads the page via `loadGrantedPage(Page, pageId, user)` and currently rejects
   invalid IDs, missing/ungranted pages, and another user's draft
   (`packages/api/src/hono/handlers/page-collab.ts:66-84`), then signs
   `{ userId, pageId, readonly }` (`page-collab.ts:88-92`). It now ALSO reads the
   page's current `collabLifecycleVersion` and signs it into the token (§5.1
   token shape), and rejects `STATUS_DELETED` before token creation with the same
   404 not-found-style response (`PAGE_NOT_FOUND_BODY`, used at
   `page-collab.ts:72,83`) so deleted-page existence is not leaked and a new token
   cannot be minted for a deleted page. `loadGrantedPage` already returns the page
   document, so the epoch is available without an extra query.
2. **WebSocket authentication checks the epoch (the primary gate) and deleted
   status.** `onAuthenticate` currently loads `_id status creator`
   (`packages/collab/src/hooks/on-authenticate.ts:157`) and rejects missing pages
   or foreign drafts (`:157-169`). It now ALSO selects `collabLifecycleVersion`
   and:
   - **rejects when `claims.epoch !== page.collabLifecycleVersion`, AND rejects
     when `claims.epoch` is ABSENT (a pre-epoch token during rollout)** — this is
     the structural fix. A token minted before a rename/soft-delete/revert carries
     the OLD epoch, so a reconnect with it is refused BEFORE any `onLoadDocument`
     runs, which is precisely why it can never record a post-transition baseline
     the way the path-CAS allowed (§0.1). A pre-epoch token (no `epoch` claim) is
     likewise rejected rather than accepted-with-fallback: accepting it and
     loading would let `onLoadDocument` record the POST-transition epoch and so
     re-open the same hole during the rollout window (§16, PINNED
     reject-and-remint). In BOTH cases the client re-requests a token via
     `onAuthenticationFailed` → `refetchToken()`
     (`CollaborativeMarkdownEditor.tsx:239`); the mint reads the NEW epoch (or
     404s if the page is now deleted), so the fresh connection materializes the
     new canonical state.
   - **rejects `STATUS_DELETED`** so a fresh token for a page soft-deleted between
     mint and connect is also blocked (belt-and-suspenders with the epoch).

   Both checks happen after token verification (`on-authenticate.ts:137-147`) and
   token/page-id correlation (`:149-152`), after the single existing page load,
   and are blocking gates that throw the same generic error so no reason is
   leaked.
3. **On-load document checks deleted status and records the epoch.**
   `onLoadDocument` currently selects only `_id revision currentRevision yjsState`
   (`packages/collab/src/hooks/on-load-document.ts:242`). It must also select
   `status` and `collabLifecycleVersion`, and reject `STATUS_DELETED` before
   recording anything or restoring `yjsState` (`on-load-document.ts:266-281`) —
   closing the auth-to-load race where soft delete commits after `onAuthenticate`
   but before materialization. The `collabLifecycleVersion` it reads is recorded
   UNCONDITIONALLY as the per-replica expected-epoch baseline for the §4.1 atomic
   CAS — in the sibling structure of §4.1.1, NOT in the conditional
   `docBaseRevisions` store (which `onLoadDocument` skips mid-drain,
   `on-load-document.ts:265-270`), so a document materializing during a drain
   still has a recorded epoch. This same recorded epoch is the value `onChange`
   stamps onto `PageYjsUpdate` rows and the value `persistYjsState` writes its CAS
   against (§4.2).

These gates prevent a deleted page from being re-opened and a stale token from
re-attaching. They complement — they do not replace — the atomic-CAS epoch
predicate of §4.1, which protects the case of an *already-open* stale socket that
skips a fresh load and tries to commit before its next reconnect.

### §5.1 wsToken payload gains an epoch claim

The wsToken today encodes `{ userId, pageId, readonly, iat, exp }`
(`WsTokenPayloadSchema`, `packages/api-contract/src/schemas/collab.ts:89-95`;
signed at `packages/api/src/util/ws-token.ts:112` with `WsTokenClaims = { userId,
pageId, readonly }`, `ws-token.ts:31-35`). This RFC adds an `epoch: number` claim
(the page's `collabLifecycleVersion` at mint time) to `WsTokenPayloadSchema`,
`WsTokenClaims`, and the `signWsToken` call at `page-collab.ts:88-92`.
`verifyWsToken` (`ws-token.ts:125-140`) already re-parses the decoded JWT through
`WsTokenPayloadSchema`, so once the schema carries `epoch`, `onAuthenticate` reads
`claims.epoch` with no additional plumbing. Because the token TTL is 5 minutes
(`ws-token.ts:23`), pre-epoch tokens minted just before rollout drain within that
window; during rollout a token with a missing `epoch` claim is REJECTED at
`onAuthenticate` and re-minted on the immediate reconnect (§16, PINNED
reject-and-remint), NOT accepted-with-fallback — accepting it and loading would
let `onLoadDocument` record the post-transition epoch and re-open the path-CAS
hole (§0.1). A missing claim is never coerced into a matching epoch. Whether
`WsTokenPayloadSchema` marks `epoch` `.optional()` for one release before
requiring it, or requires it immediately, is a payload-versioning detail (§16) —
both reject the epoch-less token at the hook. Editing `@crowi/api-contract`
requires the repository's `pnpm check:openapi` regeneration flow (§11).

## §6 Rename Contract

`Page.rename` is a public model API and must carry both the atomic epoch advance
and the lifecycle reload-prompt contract. Handler-only wiring is too easy to miss
because rename has non-handler callers and `renameTree` owns partial-success
behavior. The epoch advance rides the existing `updatePageProperty` `updateOne`
that writes the new `path` (`page.ts:1118-1120`, called at `page.ts:1431`): the
lifecycle callers pass a flag so that same conditional write also does `$inc:
{ collabLifecycleVersion: 1 }`, making the epoch move durable in lockstep with the
path. The reload-prompt emit is separate (best-effort, §6.2) and placed where it
fires for the common redirect rename (§6.1).

### §6.1 The emit (and the epoch advance) must precede the redirect branch

`Page.rename` (`packages/api/src/models/page.ts:1421-1445`) has a control-flow
subtlety that dictates where the invalidation emit goes (the epoch advance is
already durable inside `updatePageProperty` at `:1431`, before this branch):

```ts
await Page.updatePageProperty(pageData, updateData);           // :1431 — path updated (durable)
const data = await Revision.updateRevisionListByPath(...);     // :1433
pageData.path = newPagePath;                                   // :1434
if (createRedirectPage) {                                      // :1436
  const body = 'redirect ' + newPagePath;
  return Page.createPage(path, body, user, { ... });           // :1438 — RETURNS here
}
pageEvent.emit('update', pageData, user);                      // :1443 — UNREACHABLE for redirect rename
return data;                                                   // :1444
```

When `createRedirectPage` is true, the method **returns inside the redirect
branch (`page.ts:1438`) and never reaches `pageEvent.emit('update')` at
`page.ts:1443`.** The single-page rename handler passes `createRedirectPage:
Boolean(create_redirect)` and the code comments that "RenameDialog always
requests a redirect" (`packages/api/src/hono/handlers/page.ts:960-968`), so the
DEFAULT single-page rename takes the early return. Any invalidation wired to the
`:1443` `update` event would therefore **never fire for the common rename**.

The invalidation emit MUST be placed **before** the `createRedirectPage` branch,
immediately after the path update is durable (right after
`Revision.updateRevisionListByPath` at `page.ts:1433` / the `pageData.path`
assignment at `page.ts:1434`), NOT on the `:1443` `update` event. This is the
primary rename correctness path and the implementation must not regress it. The
epoch advance is independent of this placement — it is already committed inside
the `updatePageProperty` `updateOne` at `:1431`, so even if the emit path were
mis-wired, the WRITE would still be rejected by the §4.1 CAS the instant the path
row (and its epoch) changed. The emit placement only governs the proactive
*prompt*.

### §6.2 Typed invalidation option — `skip` suppresses the PROMPT, not the epoch advance

`Page.rename` should gain a typed option or callback, for example:

```ts
type PageLifecycleInvalidation =
  | { mode: 'emit'; reason: 'page-renamed' | 'page-deleted' }
  | { mode: 'skip'; reason: 'internal-repair' | 'user-activation' | 'revert-deleted' };
```

CRITICAL distinction: `mode` governs only the user-facing force-reload **prompt**.
The **epoch advance is unconditional** — every `Page.rename` invocation that
durably changes `path` advances `collabLifecycleVersion` in the same `updateOne`
(§4.0), whether `mode` is `emit` or `skip`. `skip` means "do not show a misleading
reload dialog for this internal step", NOT "leave stale editors able to write".
The epoch is what invalidates them; the prompt is courtesy. The exact TypeScript
shape can differ (Open Question §16), but it must satisfy these semantics:

- A user-facing single-page rename emits `page-renamed` immediately after the
  durable path write (`Page.updatePageProperty(...)` at `page.ts:1431`), and
  before the redirect branch (§6.1). Because model methods are NOT transactional,
  a later step in the SAME method can throw after the path is already durable:
  `Revision.updateRevisionListByPath` (`page.ts:1433`) or the redirect
  `createPage` (`page.ts:1438`) can fail with the row already renamed. The emit
  must fire right after the durable field write so those later failures do not
  suppress it — the live editor is already attached to stale lifecycle state, and
  — critically — the §4.1 atomic CAS already rejects its saves the instant the
  path row (with its incremented epoch) changed.
- The soft-delete internal `Page.rename` call — `deletePage` calls
  `Page.rename(pageData, newPath, user, { createRedirectPage: true })`
  (`page.ts:1310`) to move to `/trash/` — passes `mode: 'skip'` so it does not
  emit a spurious `page-renamed` for the same `_id` (the user-facing lifecycle
  event is `page-deleted`, emitted once by `deletePage`, §7.1). It STILL advances
  the epoch, which is harmless and monotonic: the soft-delete status write already
  advanced the epoch (§7.1), and the trash rename advancing it again only pushes
  it further ahead of any stale token — never backwards.
- `revertDeletedPage` uses internal delete/status/rename repair operations
  (`packages/api/src/models/page.ts:1315-1339`) and passes `mode: 'skip'` for the
  internal restoration rename (`page.ts:1336`) so it shows no misleading prompt —
  but that rename's epoch advance is exactly what makes the deleted-era
  `yjsState`/`PageYjsUpdate` non-replayable on the reverted page (§4.2, §7.4). Skip
  the prompt, keep the epoch.
- User activation rename (`packages/api/src/events/user.ts:24`, `Page.rename(page,
  renamedUserPagePath, user, {})`) passes `mode: 'skip'` (no user-visible collab
  prompt); its epoch advance is still harmless and keeps any live editor on that
  path consistent. If user-activation later becomes a user-visible lifecycle
  mutation, it flips to `emit` in a follow-up RFC.
- Call sites must not rely on a default that accidentally emits. Every
  lifecycle-sensitive path chooses `emit` or `skip` explicitly, so code review can
  see the intent. The epoch advance has no such choice — it is inherent to the
  path write.
- The emit operation remains best-effort. If the invalidator throws, the
  rename/delete method still reports the original mutation result; invalidation
  failure is logged but not converted into a rename/delete failure. The epoch
  advance, being part of the mutation `updateOne`, is NOT best-effort — if that
  write fails, the rename itself fails (correct: no partial "path moved but epoch
  didn't" state is possible).

### §6.3 Per-page epoch advance + emit from `Page.rename`, not batched by `renameTree`

`Page.rename` itself advances the epoch (unconditional) and emits (or skips the
prompt, per §6.2) on each successful path update, **even when it is called by
`renameTree`**. A batched emit collected after `renameTree`'s executor settles
would leave a same-process stale-prompt window between each individual path update
and the batch. Because both the epoch advance and the emit live in `Page.rename`,
each renamed page's WRITE is protected and its prompt fires the moment its path
(and epoch) becomes durable. (The §4.1 atomic CAS independently protects the WRITE
from the instant each page's epoch increments — its `collabLifecycleVersion`
predicate no longer matches — so even a delayed prompt cannot allow a stale save.
This holds for a child moved by a subtree rename too: §7.6.) §8 reconciles this
with `renameTree`'s partial-success reporting.

This contract should be represented in model tests, not only handler tests.

## §7 Delete, Hard Delete, Draft Cancel, and Revert Semantics

### §7.1 Soft delete

`Page.deletePage` marks the page deleted, deletes share rows, updates the local
document status, and renames the page under `/trash/`
(`packages/api/src/models/page.ts:1297-1313`). The implementation workflow is:

1. Check deletability (`isDeletableName` or `isNonExistentUserPage`, `page.ts:1301`)
2. Capture the page id (`pageData._id`)
3. Update status to `STATUS_DELETED` (`page.ts:1302`, `updatePageProperty`)
4. Delete Share rows (`page.ts:1303`)
5. Call `Page.rename` to move the page under `/trash/` (`page.ts:1310`)

Step 3 updates the page durably before the rename completes. If step 4 or 5 later
throws, the page is already marked deleted in the database. The epoch advance is
folded INTO step 3's `updatePageProperty` `updateOne` (`page.ts:1302`,
`page.ts:1118-1120`), so the instant `STATUS_DELETED` is durable the epoch has
ALSO moved — a stale token is refused at `onAuthenticate` and an already-open
socket's save misses the §4.1 CAS, even if steps 4-5 later throw. `Page.deletePage`
then emits `page-deleted` (the prompt) immediately after step 3 succeeds, using
the page id from step 2. This is the first durable lifecycle transition: the page
is unavailable to live collab writes even if trash-path cleanup fails.

**Collab-lineage purge (defense-in-depth).** Under the epoch, soft delete's
deleted-era `yjsState`/`PageYjsUpdate` are already NON-REPLAYABLE after a revert
(the revert advances the epoch again, §7.4, so those rows carry a stale epoch and
`onLoadDocument` skips them, §4.2). The purge is therefore no longer the
correctness mechanism — it is cleanup that keeps the append log / `yjsState` small
and covers pre-epoch legacy rows. `Page.deletePage` still, at the soft-delete
boundary (after step 3):

- NULLs the page's `yjsState` and `yjsCheckpointAt`;
- DELETEs the page's `PageYjsUpdate` append rows.

This mirrors hard delete and draft cancel (§7.2, §7.3). After the purge (or, for
any drain-window straggler, simply by epoch-mismatch at replay), a revert's
`onLoadDocument` finds no replayable lineage and body-seeds from the current
(reverted) revision (`on-load-document.ts:326-352`) — the correct canonical state.

The drain-window race (`onChange` has no per-keystroke Mongo status read and the
invalidator keeps sockets attached for ~1500ms, `on-change.ts:77`,
`invalidation.ts:217-226`) is closed by the epoch, not by purge timing: a
keystroke during the drain either does not append (the in-memory doc's epoch is
already stale — `onChange` refuses, §4.2) or appends a row stamped with the OLD
epoch that `onLoadDocument` will not replay after the revert bumps the epoch
again. The boundary purge and the revert re-purge (§7.4) simply sweep such inert
rows; correctness does not depend on catching them before the drain closes.

**Back-compat for pre-epoch already-deleted rows.** Pages soft-deleted before this
RFC shipped carry `yjsState`/`PageYjsUpdate` with no epoch field (treated as epoch
`0`) and a `collabLifecycleVersion` of `0` (post-migration default) on the page
row. A later revert of such a page advances the epoch to `1`, so the epoch-`0`
lineage is non-replayable — the epoch mechanism covers legacy rows automatically.
The revert re-purge (§7.4) additionally deletes them as cleanup. Optionally, a
one-time migration that nulls `yjsState`/`yjsCheckpointAt` and deletes
`PageYjsUpdate` rows for all rows currently in `STATUS_DELETED` may be run as a
belt-and-suspenders convenience; it is not required for correctness under the
epoch. This back-compat rule is specified in §7.4 and §16.

This means:

- The epoch advance is folded into the `STATUS_DELETED` `updateOne`
  (`page.ts:1302`); the `page-deleted` emit and the (defense-in-depth)
  collab-lineage purge belong in `Page.deletePage` (or a typed lifecycle callback
  invoked by it) immediately after that write resolves.
- Share cleanup and trash rename continue after the emit/purge. The trash rename
  (step 5) passes `mode: 'skip'` (§6.2) so it does not emit a spurious
  `page-renamed`; it still advances the epoch (harmless, monotonic).
- The non-deletable branch (`throw new Error('Page is not deletable.')` at
  `page.ts:1312`) emits nothing, purges nothing, and advances nothing — no
  lifecycle field changed.

Because the soft-deleted row still exists, the epoch check (token + auth + CAS,
§4-§5) is the authority and the deleted-page materialization gates in §5 are
complementary. Without the epoch, a stale token or a new token request could
attach to the same `_id` after the force-reload prompt, or an already-open socket
could save into it.

### §7.2 Hard delete

`Page.completelyDeletePage` removes bookmarks, attachments, comments, page rows,
redirect origins, and activities in sequence, then emits the page delete event
(`packages/api/src/models/page.ts:1344-1364`). Two distinct callers exist:

1. User-facing hard delete via `packages/api/src/hono/handlers/page.ts:711` —
   should emit `page-deleted` to invalidate editors on the removed page.
2. Internal cleanup via `packages/api/src/models/page.ts:1331` (called from
   `revertDeletedPage` to delete the redirect-origin stub) — must NOT emit
   `page-deleted` because the stub is not a live-edited page.

The current code emits a `delete` event unconditionally (`page.ts:1361`), which
feeds the API's generic page-event handler. The collab invalidation emit must
**not** be unconditional inside `completelyDeletePage`. The implementation must
add a typed option such as:

```ts
type PageRemovalInvalidation =
  | { mode: 'emit'; reason: 'page-deleted'; target: 'live-page' }
  | { mode: 'skip'; reason: 'redirect-origin-cleanup' | 'revert-deleted' | 'internal-cleanup' };
```

`Page.completelyDeletePage` then emits `page-deleted` only when called with
`mode: 'emit'` for the user-facing hard-delete surface. The emit point is
immediately after `Page.removePageById(pageId)` succeeds (`page.ts:1357`),
because the target page row has been physically removed at that point. Later
redirect-origin (`page.ts:1358`) or activity (`page.ts:1359`) cleanup failures do
not suppress collab invalidation. The internal repair call from
`revertDeletedPage` must pass `mode: 'skip'` so deleting the redirect-origin stub
does not force-reload editors of the original page.

**Epoch note.** Hard delete physically removes the page row (`page.ts:1372` via
`removePageById`/`removePage`), so there is no surviving row to carry an advanced
epoch, and the §4.1 CAS misses simply because the `_id` is gone. An already-open
socket's save loads no page (`save-flow.ts:264` `PAGE_NOT_FOUND`) and an
`onChange` append after removal is orphaned (TTL-swept, and non-replayable since
no page row exists to replay onto). No epoch `$inc` is meaningful on a removed
row; the row removal itself is the transition.

**Append-log purge.** `completelyDeletePage` does not currently remove
`PageYjsUpdate` rows (the removal sequence at `page.ts:1354-1359` does not include
them). Live collab updates are stored in `on-change.ts:77` and retained by TTL for
up to 1 hour (`packages/api/src/models/page-yjs-update.ts`). Hard delete must
synchronously remove those rows as part of the physical-delete sequence. This is
still required — not for replay-safety (there is no page row to replay onto), but
for **privacy**: after a hard delete, cancelled content must not remain
recoverable from the collab append log for up to an hour.

### §7.3 Draft cancel

Draft cancel physically removes the draft page. The handler calls
`Page.removePage` (`packages/api/src/hono/handlers/draft.ts:217`). Because
`Page.removePage` (`packages/api/src/models/page.ts:1366-1379`) is also used by
`removePageById`, `removePageByPath`, `completelyDeletePage`, and recursive
redirect-origin cleanup, the emit boundary must be explicit at the model seam.

`Page.removePage`, `Page.removePageById`, and `Page.removePageByPath` must accept
the same typed removal invalidation option described in §7.2:

- draft cancel calls `Page.removePage(page, { invalidation: { mode: 'emit',
  reason: 'page-deleted', target: 'live-page' } })`;
- `completelyDeletePage` calls `removePageById(pageId, { invalidation: {
  mode: 'skip', reason: 'internal-cleanup' } })` and performs one coalesced
  hard-delete emit at its own boundary (§7.2), so the emit is not double-fired;
- `removeRedirectOriginPageByPath` and its recursive `removePageById` calls
  (`page.ts:1403-1419`) always pass `mode: 'skip'` because redirect stubs are not
  the live-edited page being renamed or deleted;
- `removePageByPath` has no implicit default emit; callers must choose `emit` or
  `skip`.

The draft-cancel emit point is immediately after `Page.deleteOne({ _id })`
succeeds inside `removePage` (`page.ts:1372`), because the draft row has been
physically removed. As with hard delete (§7.2), the row removal is itself the
transition — no surviving row carries an epoch, so the §4.1 CAS misses on the gone
`_id`. `Page.removePage` must also remove `PageYjsUpdate` rows for that page as
part of draft cancellation, for **privacy**: otherwise a cancelled draft's live
collab deltas remain recoverable from the append log (up to the 1-hour TTL) after
the page and revisions are gone.

### §7.4 Revert deleted page

`Page.revertDeletedPage` is an internal repair operation: it deletes the redirect
origin, flips the deleted page back to published, and renames it back to the
original path (`packages/api/src/models/page.ts:1315-1339`). It must not produce a
user-facing delete prompt for the redirect-origin cleanup (`page.ts:1331`), and
it must not produce a misleading rename prompt for the internal restoration rename
(`page.ts:1336`). Both of those steps STILL advance the epoch (§6.2) — that is the
mechanism that invalidates the deleted-era collab state, not the purge.

The sequence is:

1. Find the redirect-origin stub at the new path (`page.ts:1326`)
2. Validate it points to the deleted page (`page.ts:1327-1329`)
3. Call `completelyDeletePage(originPageData)` to delete the stub
   (`page.ts:1331`) — passes `mode: 'skip'` (prompt for the stub, not the
   original page; the stub row is removed anyway)
4. Update the deleted page's status back to published (`page.ts:1332`) — this
   `updatePageProperty` `updateOne` ALSO `$inc`s the epoch (§4.0), so the
   deleted-era `yjsState`/`PageYjsUpdate` (which carry the pre-revert epoch)
   become non-replayable from this instant.
5. Call `Page.rename` to move it back to the original path (`page.ts:1336`) —
   passes `mode: 'skip'` (internal repair); its path `updateOne` advances the
   epoch again (harmless, monotonic).
6. Re-run the idempotent collab-lineage purge on the reverted page (§7.4
   defense-in-depth purge below) — null `yjsState`/`yjsCheckpointAt` and delete
   `PageYjsUpdate` rows — AFTER steps 4-5, as cleanup of the now-inert
   stale-epoch rows.

Both the `completelyDeletePage` and `rename` calls carry explicit `skip` prompt
semantics so code review can see the intent; both advance the epoch.

**Why the reverted page loads clean (epoch, not purge).** The correctness
guarantee is the epoch: after step 4 advances `collabLifecycleVersion`, the
reverted page's `onLoadDocument` records the NEW epoch and its residual-replay /
`yjsState`-restore filter by the current epoch (§4.2), so any deleted-era
`yjsState` or `PageYjsUpdate` — pre-epoch legacy rows treated as epoch `0`, or
drain-window `onChange` stragglers stamped with the old epoch — does not match and
is not applied. The load body-seeds from the reverted revision. This holds even if
step 6's purge failed or hadn't run yet.

**Defense-in-depth re-purge (cleanup).** `revertDeletedPage` still re-runs an
idempotent "purge-if-present" of the page's collab lineage as step 6, AFTER the
status flip and internal rename. It is no longer load-bearing for correctness, but
it keeps the append log / `yjsState` small and covers two populations without
relying on TTL:

- **Pre-epoch already-deleted rows.** Pages soft-deleted before this RFC shipped
  carry deleted-era `yjsState`/`PageYjsUpdate` at epoch `0`; the epoch filter
  already refuses to replay them once the revert advances the epoch, and step 6
  deletes them.
- **Drain-window `onChange` stragglers.** A row appended during the ~1500ms drain
  is either refused by `onChange`'s epoch guard or stamped with the old epoch
  (§4.2); either way it is non-replayable after the revert. Step 6 sweeps any that
  landed. Ordering it after steps 4-5 (not around step 4) means the sockets are
  closed and no new straggler can appear after the sweep — a tidiness property,
  not a correctness one (the epoch already covers a post-sweep straggler by
  refusing to replay its stale epoch).

For a page reverted with no straggler, step 6 finds nothing and is a no-op.

If a later product decision wants live editors on a deleted page's trash path to
receive a prompt during revert, that should be designed as a separate user
workflow. It is not part of this first implementation.

### §7.5 Ordering Contract and Partial-Mutation Safety

`Page.deletePage` at `page.ts:1302` calls `updatePageProperty` (a direct
`updateOne` at `packages/api/src/models/page.ts:1118-1120`), making the deletion
durable before `Page.rename` (`page.ts:1310`) is even called. If rename throws,
the page is already marked deleted. Similarly, `Page.rename` updates the page path
first (`page.ts:1431`), then updates all revision paths (`page.ts:1433`), then
conditionally creates a redirect (`page.ts:1436-1441`). If redirect creation
throws, the original page has already been renamed.

The invalidation boundary is the database mutation that makes the page unavailable
or stale, even if a later cleanup step within the same logical operation throws.
Crucially, because the epoch `$inc` rides the SAME `updateOne` as that mutation
(§4.0), the WRITE-safety boundary is exactly the mutation itself — there is no
window where the field changed but the epoch didn't. This is because:

- Soft delete: the page is unavailable once `STATUS_DELETED` (and its epoch `$inc`)
  is written (step 3), not after the rename completes.
- Rename with redirect: the original page is stale once the path (and its epoch
  `$inc`) is updated (step 1 of rename), even if redirect creation fails — and
  because the emit is placed before the redirect branch (§6.1), the prompt fires
  regardless.

Model methods are NOT transactional, so a partial mutation is a real state, not a
hypothetical: `deletePage` writes `STATUS_DELETED` (`page.ts:1302`) before later
Share-delete (`page.ts:1303`) or trash-rename (`page.ts:1310`) work can throw, and
`Page.rename` mutates `path` (`page.ts:1431`) before the redirect `createPage`
(`page.ts:1438`) can throw. A "failed method emits nothing" rule would therefore
be WRONG — it would leave editors attached to a page whose lifecycle field
already, durably, changed. The implementation must instead:

1. Advance the epoch atomically with, and emit for, the page whose lifecycle field
   **actually changed**, immediately at that durable field write, NOT after the
   whole method resolves. For soft delete, the epoch `$inc` + `page-deleted` emit
   ride the `STATUS_DELETED` write (`page.ts:1302`). For user-facing rename, the
   epoch `$inc` rides the `path` write (`page.ts:1431`) and the `page-renamed` emit
   fires before the redirect branch. For hard delete / draft cancel, the row is
   removed (`page.ts:1357` / `page.ts:1372`) and the emit fires there.
2. Because the epoch advance is IN the durable field write (not gated on method
   success) and the emit is placed at that write, a later step that throws (Share
   delete, revision-path update, redirect creation, activity cleanup) cannot
   suppress either the WRITE rejection (the epoch already moved) or the prompt for
   a field that already changed. This reconciles the §7.1 soft-delete, §7.2
   hard-delete, and §6 rename descriptions: each advances the epoch and emits at
   ITS OWN first durable field write.
3. Keep validation failures that throw BEFORE any lifecycle field is written
   (e.g. the non-deletable branch at `page.ts:1312`) as genuine no-op cases —
   nothing durable changed, the epoch did not move, so no editor is stale.

Transactions would also be valid if a later implementation wraps the entire
logical operation and advances the epoch only after commit (documenting explicit
compensation for the fields it rolls back). That is a larger change and is not the
design chosen here. The chosen first implementation is advance-epoch-and-emit-at-
first-durable-field-write plus explicit skip-prompt semantics for internal cleanup
paths, with cross-replica write safety guaranteed by the epoch in the §4.1 atomic
CAS.

### §7.6 Subtree rename moves children, and each open child editor is a legitimate conflict + reload

A subtree rename does not move only the directly-renamed page. The handler builds
a path map over the root plus every grant-visible descendant
(`packages/api/src/hono/handlers/page.ts:891`, via `Page.getPathMap`,
`page.ts:1447`) and `Page.renameTree` renames each entry in that map
(`page.ts:1485-1508`), so a parent rename changes the `path` of every descendant
row too. This has two consequences the design must state explicitly, because they
are correct-but-surprising:

- **Every open descendant editor's next save is an epoch-guard CONFLICT.** Each
  descendant is moved by its own `Page.rename` call (§6.3), whose `path`
  `updateOne` also `$inc`s that child's epoch (§4.0). The §4.1 atomic CAS on that
  child's own `executeSave` then no longer matches (`expectedEpoch` was recorded
  before the move), so the child editor's save is rejected with the same
  reload-required outcome as a direct rename. This is the intended behavior: the
  child genuinely moved and must reload; it is a legitimate conflict-reload, not a
  spurious one. (The child's stale token is likewise refused at `onAuthenticate`
  on its next reconnect, its epoch having advanced.)
- **Every open descendant editor gets a reload prompt.** Because the emit lives
  in `Page.rename` (§6.3) and `renameTree` calls `Page.rename` once per mapped
  page, each descendant fires its own `page-renamed` broadcast to its OWN
  `documentName` (`invalidation.ts` keys everything by page id / documentName),
  so an editor open on a moved child receives the reload prompt for that child —
  not only the editor on the directly-renamed root.

The design therefore accepts and requires: a subtree rename produces an
epoch-guard CONFLICT + reload prompt for EVERY open descendant editor, keyed per
child page id. §12 adds a subtree-child test case and §10 extends the acceptance
criteria to require the descendant reload prompt, not only the root's.

## §8 `renameTree` Partial-Failure Semantics

`Page.renameTree` is non-transactional and bounded-concurrency. It uses
`mapWithConcurrency` (`packages/api/src/models/page.ts:92-103`) to run multiple
renames in parallel with a concurrency limit (`RENAME_TREE_CONCURRENCY = 8`,
`page.ts:85`). The worker loop has **no cancellation or rejected flag**: each
worker's `while (cursor < items.length)` loop keeps pulling the next index and
starting a rename even after a *sibling* worker's `await fn(items[index])` has
rejected (`page.ts:96-98`). The rejection only propagates once the `Promise.all`
over the workers settles (`page.ts:101`); until then, surviving workers continue
starting new renames. So the set of pages that actually got renamed before the
throw is **not** just the in-flight set at rejection time — it is every rename
that any still-running worker completed until all workers quiesced.

The current `renameTree` (`page.ts:1495-1508`) wraps each rename in a try-catch
that rethrows `Failed to update page (...)` on any failure. Combined with
`mapWithConcurrency`'s `Promise.all`, this means:

- If rename N fails, the executor eventually rejects and `renameTree` throws.
- Renames started by other workers before the rejection surfaced run to
  completion, but their results are lost because the thrown aggregate discards
  the results array (`page.ts:1495` `return mapWithConcurrency(...)` never
  resolves on the throw path).
- The handler sees a `400` response and reports "some pages may already have been
  moved" (`packages/api/src/hono/handlers/page.ts:913-918`), but the naive "batch
  emit only successful ids after `renameTree` returns" is impossible — those
  post-first-rejection successful renames are never reported back.

This is why §6.3 places the epoch advance + emit inside `Page.rename` (per
successful path update) rather than batching it in `renameTree`: the per-page
epoch `$inc` and emit fire immediately for every page that actually moved,
independent of whether `renameTree` ultimately throws. The §4.1 atomic CAS
likewise protects each moved page's WRITE from the moment its epoch increments —
its `collabLifecycleVersion` predicate stops matching — including every descendant
moved by a subtree rename (§7.6).

For reporting/observability, the implementation should still improve
`renameTree`'s control flow so successes are not silently lost:

- Modify `renameTree` to collect per-item success/failure in an allSettled-style
  result: `{ successes: PageDocument[], failures: { oldPath, error }[] }`.
- Ensure each rename attempt is wrapped with `.catch()`/`.then()`, not propagated
  as a throw, so all scheduled renames run to completion and their outcomes are
  captured (note that `mapWithConcurrency`'s workers already keep starting work
  after a rejection — capturing per-item results makes that observable instead of
  lossy).
- Return the typed result so the caller can report which ids moved.

The Hono handlers already tell users that partial subtree moves may have occurred
on 400 responses (`packages/api/src/hono/handlers/page.ts:913-918`,
`:1051-1055`). The collab contract matches that reality: already-renamed pages have
their epoch advanced and their prompt emitted (via the per-page `Page.rename`),
and their stale saves are blocked (via the §4.1 epoch CAS) even when `renameTree`
ultimately reports partial failure. "Emit nothing on failure" is not acceptable
for `renameTree` because it would leave editors attached to pages that did move.

## §9 Multi-Replica Behavior

Phase 1 delivers the force-reload **prompt** only within the API process that
performed the mutation, but makes the **write** safe on every replica. The
cross-replica write guarantee rests on TWO explicit preconditions, both
established earlier in this RFC:

1. The lifecycle authority is the epoch on the ATOMIC pointer CAS (§4.1), a single
   conditional `updateOne` against the CANONICAL Mongo row that every replica
   shares. A rename/delete/revert/body-replace committed on replica A advances
   that row's `collabLifecycleVersion` (in the same `updateOne` as the mutation),
   so a CAS running on ANY replica reads the freshly-mutated row and misses — the
   write is rejected wherever it runs.
2. The `collabLifecycleVersion: expectedEpoch` predicate in that CAS is the value
   THIS replica recorded at its own `onLoadDocument` (§4.1.1), server-side and
   process-local. It is never client-supplied, and — because a stale token is
   refused at `onAuthenticate` on any replica (§5) — a replica-B editor cannot
   even reload to capture a post-transition epoch; it must mint a fresh token
   first.

Given those two preconditions:

- **Write safety (Phase 1, cross-replica).** A rename/delete on replica A is
  enforced by any `executeSave` on replica B: the CAS predicate
  `collabLifecycleVersion: <replica-B's recorded pre-move epoch>` no longer
  matches the row A mutated (whose epoch A advanced), so B's save is rejected at
  the durable write. This specifically closes the **cross-replica rename WRITE**:
  because a rename does not move `currentRevision`, the pre-existing `{ _id,
  currentRevision }` lock would still have matched on replica B — it is the added
  epoch predicate, reading the canonical row, that rejects it. (Note this is the
  epoch closing the WRITE, not the doc-base "reconnect/save conflict", which does
  NOT fire for a rename since `currentRevision` is unchanged.) The §5
  materialization gates (token/auth epoch check) and the §7 collab-lineage purge
  likewise run against shared Mongo state, so no replica can mint a valid token
  for, re-materialize, or resurrect `yjsState`/`PageYjsUpdate` for a
  renamed/deleted page.
- **Prompt delivery (Phase 1, process-local).** The invalidation module
  explicitly documents that docs on other replicas are unreachable without Redis
  pub/sub (`packages/collab/src/invalidation.ts:31-35`), and
  `AttachedCollab.invalidatePages` delegates only to the local invalidator
  (`packages/api/src/collab/attach.ts:367-369`). So an editor on replica B keeps
  its live Y.Doc (with no reload dialog) until it next reconnects or attempts a
  save — at which point the §4.1 epoch CAS rejects the save with a reload-required
  error, and its next reconnect is refused at `onAuthenticate` until it mints a
  fresh token (§5). The user is never able to persist stale content or resurrect
  stale state; they only miss the *proactive* prompt. Delivering that prompt to
  replica-B editors is the Phase-2 Redis fanout below; the WRITE is already safe
  everywhere.

Crowi's collaborative editing stack is otherwise multi-instance capable when
Redis is configured: `attach.ts` adds `@hocuspocus/extension-redis` when a Redis
client exists (`packages/api/src/collab/attach.ts:244-258`), and RFC-0003
documents the in-process Hocuspocus model scaling through Redis-backed API
replicas.

Phase 1 must document this in the operator-facing realtime collab docs: with
multiple API replicas, a rename/delete is *write-safe* everywhere but the
proactive reload prompt only reaches editors on the mutating replica until the
Phase-2 fanout lands. This is a UX latency caveat, not a data-integrity one.

The Phase-2 multi-replica prompt phase should add a Redis pub/sub channel for
lifecycle invalidation, for example `{ pageIds, reason, originInstanceId,
eventId }`. Each API process would subscribe, call its local invalidator for
matching page ids, and tolerate or ignore its own echo. Presence and
notification fanout already provide local patterns for Redis subscriber lifecycle
and narrow client interfaces. The exact channel name and payload schema are an
Open Question (§16).

## §10 Web UX and Payload

The editor keeps the current force-reload prompt. `page-renamed` and
`page-deleted` are reasons for the same safety workflow, not instructions to
auto-reload or redirect.

Current client behavior is already aligned with this:

- the collaborative editor listens for `crowi:force-reload` stateless messages
  and passes the reason through to the page client;
- the edit page snapshots the recovery buffer and opens `CollabForceReloadDialog`;
- the page intentionally does not auto-reload so unsaved local text can be
  recovered.

Implementation may improve reason-specific copy in the dialog, but the first
acceptance criteria are behavioral:

- a rename opens the reload prompt (on the mutating replica);
- a delete opens the reload prompt (on the mutating replica);
- a **subtree rename opens the reload prompt for every open descendant editor**,
  not only the directly-renamed root — each moved child page fires its own
  `page-renamed` broadcast keyed to that child (§7.6, on the mutating replica);
- neither path silently refreshes the page;
- neither path attempts to live-merge stale Y.Doc content into the renamed or
  deleted canonical page;
- a stale save attempted after rename/delete (including from another replica, and
  including a save from an editor open on a child moved by a subtree rename) is
  rejected by the §4.1 epoch CAS and surfaces as the same reload-required outcome.

## §11 API Contract / OpenAPI Effects

The reload-prompt reasons `page-renamed` and `page-deleted` do not by themselves
require an OpenAPI change — the force-reload stateless payload already carries a
string reason, and the new save-flow rejections surface through the EXISTING
atomic-CAS miss branch (`matchedCount === 0`, `save-flow.ts:399-467`): a CAS that
misses because of the added epoch/status predicate settles to the same `CONFLICT`
reload-required outcome the doc-base lock already produces (`save-flow.ts:466`),
one of the existing `CollabSaveError` discriminants (`save-flow.ts:29`). So the
lifecycle rejections surface through the already-documented save-failure channel
rather than a new contract shape.

The wsToken payload change, however, DOES touch the contract. Adding the `epoch`
claim to `WsTokenPayloadSchema` (`packages/api-contract/src/schemas/collab.ts:89-95`)
is a `@crowi/api-contract` edit and MUST be built (`pnpm --filter
@crowi/api-contract build`) and regenerated through the repository's
`pnpm check:openapi` flow so the committed OpenAPI artifacts do not drift (the
pre-push hook enforces this when `packages/api-contract/**` changes). The wsToken
is an internal JWT (not itself an OpenAPI response body — the `WsTokenResponse`
that IS returned, `collab.ts:67-72`, is unchanged: it carries the opaque `wsToken`
string, not the decoded claims), so no public response schema changes; the
regeneration is required because the shared schema module is part of the built
contract package. The Yjs-token endpoint should additionally document that deleted
pages are rejected with the existing `PAGE_NOT_FOUND_BODY` 404 shape (§5), which
is a doc-only change to an existing response.

If the implementation ALSO formalizes the reason codes as a contract enum or
threads any other documented request/response field, it updates
`@crowi/api-contract` and regenerates OpenAPI artifacts through the same flow.

The Yjs-token endpoint should document that deleted pages are unavailable. The
preferred response is the same 404/not-found-style body already used for missing,
ungranted, or hidden draft pages (`PAGE_NOT_FOUND_BODY`,
`packages/api/src/hono/handlers/page-collab.ts:72,83`), so the endpoint does not
expose whether a deleted page id exists.

## §12 Tests

Tests should be split by the layer that owns the behavior.

Epoch model tests (the correctness core):

- Every collab lifecycle transition advances `collabLifecycleVersion` in the SAME
  `updateOne` as the mutation: rename (`updatePageProperty` path write), soft
  delete (`STATUS_DELETED` write), revert (status flip + internal rename), and
  external body replace (`Page.updatePage`). Assert the row is never observable at
  the old epoch after the mutated field is durable.
- A validation failure BEFORE any lifecycle field is written (the non-deletable
  branch, `page.ts:1312`) does NOT advance the epoch.
- `skip`-mode `Page.rename` (soft-delete trash rename, revert internal rename,
  user-activation) STILL advances the epoch (assert the row's epoch increments)
  while suppressing the `page-renamed` prompt — the §6.2 "skip the prompt, keep the
  epoch" contract.

Model-level tests:

- `Page.deletePage` emits `page-deleted` and advances the epoch immediately after
  the soft-delete status update succeeds, even if later share cleanup or trash
  rename throws.
- `Page.deletePage` purges collab lineage (nulls `yjsState`/`yjsCheckpointAt`,
  deletes `PageYjsUpdate` rows) at the soft-delete boundary (defense-in-depth).
- A non-deletable `deletePage` attempt emits no invalidation, purges nothing, and
  does not advance the epoch.
- The soft-delete internal `Page.rename` to `/trash/` does NOT emit a spurious
  `page-renamed` (it passes `mode: 'skip'`) but DOES advance the epoch.
- `Page.completelyDeletePage` emits `page-deleted` only for typed user-facing
  hard-delete calls and skips internal revert cleanup.
- `Page.completelyDeletePage` emits after the target page row is removed, and
  still emits if later redirect-origin/activity cleanup throws.
- `Page.completelyDeletePage` also removes `PageYjsUpdate` rows for the page
  (privacy, §7.2).
- `Page.removePage`, `removePageById`, and `removePageByPath` respect typed
  skip/emit semantics so draft cancel and recursive cleanup paths do not
  over-fire.
- `Page.removePage` removes `PageYjsUpdate` rows for draft cancel (privacy).
- `Page.revertDeletedPage` uses explicit skip-prompt semantics for its internal
  repair operations (redirect cleanup, internal rename), ADVANCES the epoch on the
  status flip + internal rename, and re-runs the idempotent collab-lineage purge
  AFTER those (§7.4 step 6) as cleanup.
- After soft-delete → `revertDeletedPage`, a subsequent `onLoadDocument`
  body-seeds from the reverted revision and does NOT restore the deleted-era Y.Doc
  — because the revert advanced the epoch, so the deleted-era `yjsState` and
  `PageYjsUpdate` rows carry a stale epoch and are not replayed — **including the
  case where a `PageYjsUpdate` row was appended for the deleted `_id` during the
  drain window** (simulate an old-epoch `onChange` append; assert the load does
  not replay it even if the re-purge had not yet run — §4.2, §7.4).
- `Page.rename` exposes a typed invalidation contract; a user-facing rename emits
  `page-renamed` **immediately after the durable `path` write and before the
  redirect branch** — including the default `createRedirectPage: true` case that
  early-returns at `page.ts:1438` — so the common redirect rename still fires
  (regression test for §6.1), and the emit still fires (and the epoch is already
  advanced) when a later step (revision-path update / redirect creation) throws
  (partial-mutation, §7.5).
- `Page.renameTree` uses an allSettled-style executor and reports successful ids
  plus failures; each moved page has its epoch advanced and its prompt emitted via
  the per-page `Page.rename` even when the handler returns a partial-failure 400
  (and successes started after the first rejection are captured, not lost — §8).
- A **subtree rename** invalidates every moved descendant: renaming a parent with
  open child editors advances each child's epoch and fires a `page-renamed`
  broadcast per child page id (§7.6), not only for the root.
- Null/missing invalidator attachment remains safe and does not fail writes (the
  epoch advance, being in the mutation `updateOne`, is unaffected).

Save-flow write-safety tests (the cross-replica correctness core):

- a save carrying a stale `expectedEpoch` (the page's epoch was advanced by a
  rename/delete/revert/body-replace after the doc was materialized) is rejected at
  the ATOMIC pointer CAS (the `collabLifecycleVersion: expectedEpoch` predicate
  makes the conditional `updateOne` match zero rows), surfacing as the `CONFLICT`
  reload-required outcome — assert this specifically for a RENAME, where
  `currentRevision` is unchanged and the `{ _id, currentRevision }` portion would
  otherwise match, so ONLY the epoch predicate rejects it;
- the rejection holds even when the mutation lands AFTER the save's page load /
  render (the TOCTOU case a pre-render check alone would miss — the epoch is on the
  final atomic write);
- a save into a `STATUS_DELETED` page is rejected (both by the advanced epoch and
  by the complementary `status: { $ne: STATUS_DELETED }` predicate);
- a lifecycle-driven CAS miss is NEVER mis-coalesced into a false save-ok — since
  a lifecycle transition does not advance the in-process doc base, `tryCoalesce`'s
  base-advanced condition (`save-flow.ts:196-205`) cannot hold and the miss
  settles to `CONFLICT`;
- the expected epoch is server-recorded and a client-supplied value CANNOT bypass
  the guard (drive `executeSave` with the replica's own recorded epoch, not a value
  from the caller);
- a document that materializes DURING an invalidation drain still has a recorded
  expected epoch (the sibling structure is written unconditionally at load,
  §4.1.1) — its stale save is still rejected;
- a process that recorded NO epoch (synthetic driver / restart-since-load) omits
  the epoch predicate and cannot manufacture a matching stale epoch — the fallback
  is fail-safe, not a bypass;
- the epoch predicate fires regardless of which "replica" performed the mutation
  (simulate by advancing the DB row's epoch directly, then driving `executeSave`
  with a doc base and expected epoch recorded from before the mutation);
- stale post-delete / post-rename Yjs content CANNOT be persisted through the
  guarded save-flow (hence never becomes a Revision, never renders — §13).

Intermediate-state (append/replay/checkpoint) tests:

- `onChange` stamps the in-memory doc's epoch onto each `PageYjsUpdate` row, and
  REFUSES to append when that in-memory epoch is stale (§4.2);
- `onLoadDocument` replays ONLY `PageYjsUpdate` rows whose
  `collabLifecycleVersion` equals the page's current epoch; a stale-epoch row is
  skipped (and best-effort swept);
- `persistYjsState` writes with a `collabLifecycleVersion: expectedEpoch` filter
  and treats zero matched rows as no persistence (a stale-epoch checkpoint cannot
  land / cannot resurrect `yjsState` after a lifecycle transition), with the
  complementary `status: { $ne: STATUS_DELETED }` also asserted for legacy rows.

Handler or supertest coverage:

- single-page rename through the Hono page handler reaches the model contract,
  advances the epoch, and the emit fires for the redirect rename;
- draft cancel invalidates a live draft editor after removal succeeds and removes
  append-log rows;
- hard delete through the handler invalidates and cleans up append-log rows;
- contract-level behavior for Yjs-token deleted-page rejection is documented and
  tested;
- the Yjs-token response is unchanged on the wire (opaque `wsToken` string) but the
  minted token now encodes the page's current epoch (assert via `verifyWsToken`
  in a unit test, not the HTTP body).

Collab lifecycle / epoch-gate tests (the stale-token core):

- **a token minted before a rename is refused at `onAuthenticate` after the rename
  (its `epoch` no longer matches the row) — the case the path-CAS could not close
  (§0.1); assert the connection is rejected BEFORE `onLoadDocument` runs**;
- a token minted before a soft delete is refused at `onAuthenticate` after the
  delete (epoch mismatch AND deleted-status), so no post-delete load occurs;
- a token minted before a revert is refused after the revert (epoch mismatch);
- token issuance signs the page's current `collabLifecycleVersion` into the wsToken
  (unit-test the claim via `verifyWsToken`);
- token issuance rejects a soft-deleted page with the same not-found-style response
  as missing/ungranted pages;
- WebSocket auth also rejects a fresh token request for a deleted page (same
  response style);
- a legacy pre-epoch token (no `epoch` claim) during rollout is REJECTED at
  `onAuthenticate` (asserting rejection BEFORE `onLoadDocument` runs, so no
  post-transition epoch is recorded) rather than accepted-with-fallback or
  coerced into a matching epoch, and a subsequent mint issues an epoch-bearing
  token (§16 PINNED reject-and-remint);
- `onLoadDocument` rejects deleted pages before materializing Y.Doc, and records
  the page `collabLifecycleVersion` UNCONDITIONALLY (even mid-drain) as the
  per-replica expected-epoch baseline for the atomic CAS (§4.1.1).

Invalidator lifecycle tests:

- detaching a document from `instance.documents` does not make its stale
  connections unreachable by the drain path;
- a fresh `onLoadDocument` cannot overwrite the invalidated doc-base sentinel
  while a stale detached socket can still save;
- connection drain tests are pinned to the installed Hocuspocus 4 behavior so a
  dependency upgrade that changes `closeConnections` semantics is caught.

Existing seams to reuse include the API model invalidator stub pattern in
`packages/api/src/models/page-external-edit.test.ts` and the collab invalidation
lifecycle tests in `packages/collab/src/__tests__/invalidation-lifecycle.test.ts`.

## §13 Security / Correctness

- **Stale write safety (the primary guarantee).** With `collabLifecycleVersion:
  expectedEpoch` folded into the ATOMIC pointer CAS (§4.1) — advanced atomically
  with every lifecycle mutation (§4.0) — a live editor cannot persist into a
  renamed, deleted, reverted, or body-replaced page. The rejection happens at the
  durable write, so there is no TOCTOU window where a stale render commits between
  a pre-check and the write; and because the epoch is minted into the token and
  checked at `onAuthenticate` (§5), a stale reconnect is refused before it can even
  load. This closes the hole a path/status CAS could not: a stale token that
  reconnected after a rename would have recorded the POST-rename path at load and
  passed a path predicate (new-vs-new, §0.1); it cannot pass the epoch, whose
  authorization happens at the token boundary BEFORE that load. This matters
  because the write is not benign: the save flow renders and PERSISTS renderer
  output (`Revision.prepareRevision` sets `renderedAst`, `revision.ts:346`), and
  the web render path later parses raw markdown-embedded HTML with no
  `rehype-sanitize` — `renderMdastToReactNode` runs `toHast(..., {
  allowDangerousHtml: true })` and `raw(hast)`
  (`packages/web/src/components/editor/render-mdast.ts:166,180`), and both the
  show page (`packages/web/src/components/page-view/page-content.tsx`) and the
  editor preview (`packages/web/src/components/editor/MarkdownPreview.tsx`) render
  through it. If a stale post-delete/post-rename Y.Doc could be saved, its
  arbitrary HTML would later flow through that unsanitized renderer. The epoch CAS
  closes this **at the durable write boundary** — the stale content never becomes a
  Revision, so it is never stored and never rendered. This is cross-replica safe
  because the CAS reads the canonical Mongo row. Tests must assert that stale
  post-delete/post-rename content cannot be saved through the guarded save-flow,
  including when the mutation lands mid-save (TOCTOU) and including a stale-token
  reconnect after a rename.
- **Deleted-page access.** Soft delete is a state transition on an existing id.
  The epoch advance refuses a stale token at `onAuthenticate` and misses the
  already-open socket's save at the CAS; token issuance, WebSocket auth, and
  `onLoadDocument` additionally reject deleted status (§5) so a deleted page cannot
  be re-opened. These gates are required because invalidation (the prompt/drain) is
  not the authorization boundary — the epoch is.
- **Information disclosure.** Token issuance, auth, and load collapse deleted-page
  rejection into the same not-found-style response as missing/ungranted/draft
  denial (`PAGE_NOT_FOUND_BODY`). They must not expose that a deleted page id
  exists. The epoch mismatch at `onAuthenticate` throws the same generic error as
  every other auth rejection, so it leaks no reason either.
- **Collab-lineage resurrection.** Because soft delete leaves the `_id`, a naive
  implementation would let `revertDeletedPage` restore the deleted-era `yjsState`
  (`on-load-document.ts:281`) and replay deleted-era `PageYjsUpdate`
  (`on-load-document.ts:422`). The epoch closes this structurally: the revert
  advances `collabLifecycleVersion`, so the deleted-era `yjsState` checkpoint and
  `PageYjsUpdate` rows carry a stale epoch and are NON-REPLAYABLE by
  `onLoadDocument`'s epoch-filtered replay (§4.2) — the reverted page body-seeds
  from its reverted revision. This does NOT depend on drain timing: a drain-window
  `onChange` straggler is either refused (stale in-memory epoch) or stamped with
  the old epoch and skipped at replay. `persistYjsState`'s epoch CAS
  (`persist-yjs-state.ts:128` → `{ _id, collabLifecycleVersion: epoch, … }`)
  likewise prevents a straggler checkpoint from re-creating `yjsState` after the
  epoch moved. The soft-delete boundary purge and the revert re-purge (§7.1, §7.4)
  remain as defense-in-depth cleanup of the now-inert rows and to sweep pre-epoch
  legacy rows.
- **Append-log cleanup.** Hard delete and draft cancel remove `PageYjsUpdate`
  rows (currently not in the removal sequence, §7.2-7.3). Otherwise deleted-page
  collab deltas remain recoverable from the update log for up to 1 hour, a privacy
  gap — independent of the epoch (which governs replay, not raw retention).
- **Partial-mutation safety.** Model methods are not transactional (§7.5), so the
  epoch `$inc` rides the SAME `updateOne` as the lifecycle field it guards — right
  after the `STATUS_DELETED` write (`page.ts:1302`), the `path` write
  (`page.ts:1431`), or the row removal (`page.ts:1357`/`:1372`). There is no window
  where the field changed but the epoch didn't, so a later step throwing (Share
  delete, revision-path update, redirect creation, activity cleanup) cannot leave a
  stale editor able to write: the epoch already moved and the §4.1 CAS already
  rejects its saves. The prompt is emitted at that same durable write and is
  likewise not gated on method success. Only failures that throw BEFORE any
  lifecycle field is written (the non-deletable branch, `page.ts:1312`) are genuine
  no-op cases (§7.5, §8).
- **Replica-local prompt gap.** Phase-1 prompt delivery is process-local, so
  remote-replica editors may not receive the proactive reload dialog until the
  Phase-2 Redis fanout. This is a UX latency gap only: write safety (epoch CAS +
  token/auth epoch check) and lineage purge run against shared Mongo state and hold
  on every replica.
- **Internal repair paths.** Revert and user-activation rename operations advance
  the epoch (to invalidate stale collab state) but explicitly skip the user-facing
  reload prompt so internal maintenance does not show misleading dialogs (§6.2).

## §14 Alternatives Considered

### §14.1 Full Redis fanout in the first implementation

A fully multi-replica *prompt* implementation would publish lifecycle
invalidation events over Redis and have every API process call its local
invalidator. This best matches Crowi's multi-instance collab story and is the
Phase-2 work.

It is not the first implementation because it expands the *prompt* feature into
channel schema design, subscriber lifecycle, idempotency, origin echo handling,
Redis failure semantics, and multi-replica tests. Crucially, it is not required
for *correctness*: the epoch (in the §4.1 save-flow CAS and the §5 token/auth
gates) already makes the write safe on every replica in Phase 1, so Phase 2 only
improves proactive prompt latency.

### §14.2 Handler-only invalidation wiring

Handler-only wiring would add calls after the obvious rename/delete handlers and
leave `Page.rename` unchanged. This has the smallest diff, but it treats a model
lifecycle invariant as a controller detail, and — because `Page.rename`
early-returns in the redirect branch (§6.1) — it is exactly the kind of wiring
that silently misses the common rename. `Page.renameTree`, user activation, soft
delete, and revert paths prove that rename/delete is broader than one HTTP
handler. Rejected: future model callers would easily miss invalidation.

### §14.3 Rely on the existing revision-pointer CAS as-is for rename write-safety

One might hope the existing doc-base compare-and-set (`save-flow.ts:385-386`)
already blocks stale saves after a rename. It does not: `Page.rename` changes only
`path`, not `currentRevision` (`page.ts:1428,1431`), so the CAS filter `{ _id,
currentRevision: docBaseFilterValue }` still matches and the stale save lands.
DECISION 1 does not add a SEPARATE guard — it EXTENDS this same atomic CAS filter
with the `collabLifecycleVersion: expectedEpoch` predicate (§4.1), keeping a single
conditional write as the authority (so there is no TOCTOU gap a separate pre-render
guard would leave). Rejected as insufficient in its current form; the CAS is the
right mechanism once its filter carries the lifecycle epoch.

### §14.3a Extend the CAS with a `path`/`status` predicate instead of an epoch

A tempting narrower fix records the page's `path` at `onLoadDocument` and folds
`path: expectedPath` (plus `status: { $ne: STATUS_DELETED }`) into the CAS,
without adding a Page field or touching the token. This is REJECTED because it is
**self-invalidating** (§0.1):

- `expectedPath` is recorded at load, from the row as it exists at load. The
  wsToken carries no path and is not re-authorized against the pre-rename state
  (its claims are `{ userId, pageId, readonly, iat, exp }`,
  `api-contract/src/schemas/collab.ts:89-95`), so a stale token — valid for 5
  minutes (`ws-token.ts:23`) — can reconnect AFTER a rename. That reconnect
  triggers a fresh `onLoadDocument` which records the POST-rename path as
  `expectedPath`. The CAS then compares post-rename `expectedPath` against the
  (still post-rename) row → they match → the stale editor's save lands in the
  renamed page. The guard compares new-vs-new and passes.
- No amount of "record it in a sibling structure, unconditionally at load" fixes
  this: the defect is not WHERE the path is stored but WHEN it is captured
  (downstream of the transition) and the ABSENCE of a token-level gate.

The epoch closes it because it is (a) advanced at the transition, (b) minted INTO
the token before the transition, and (c) checked at `onAuthenticate` — so a stale
token is refused before it can trigger a post-transition load and record a
post-transition baseline. The status/path predicates MAY remain as complementary
defense (the `status` predicate is cheap and explicit), but they are not the
authority.

### §14.4 Invalidation without deleted-status gates / lineage purge

Emitting `page-deleted` alone would show a prompt to currently connected editors,
but it would not reject a new token, a stale-token reconnect, a later save against
the same soft-deleted `_id`, or a revert that restores the deleted-era Y.Doc.
Rejected because soft delete is not a physical disappearance at the identity layer,
and the surviving collab lineage is directly restorable by revert.

### §14.5 Automatic reload or redirect

The editor could auto-reload on delete or redirect to the new path on rename. That
is rejected for the first implementation because it can discard local editor state
and conflicts with the existing recovery-buffer prompt model. Reason-specific
dialog copy is acceptable; silent navigation is not.

### §14.6 Per-message deleted-page revocation

Checking deleted status from `beforeHandleMessage` on every inbound Yjs message
would close already-open sockets sooner. It is rejected for the first
implementation because write correctness is already enforced by the epoch at the
§4.1 atomic CAS and the §5 token/auth gates, without per-message DB overhead. A
Redis-backed tombstone cache can be reconsidered with the Phase-2 fanout to close
sockets sooner, but it is not the write-safety boundary.

## §15 Phased Plan

### §15.1 Phase 1 — Single-replica prompt + cross-replica write safety

- Add `collabLifecycleVersion` (Number, default `0`) to the Page schema
  (`page.ts`) and to the migration that backfills existing rows to `0`; add
  `collabLifecycleVersion` (Number) to the `PageYjsUpdate` schema
  (`page-yjs-update.ts`).
- Advance the epoch with `$inc: { collabLifecycleVersion: 1 }` in the SAME
  `updateOne` as each lifecycle mutation: rename (`updatePageProperty` path write),
  soft delete (`STATUS_DELETED` write), revert (status flip + internal rename),
  external body replace (`Page.updatePage`); hard delete / draft cancel remove the
  row (no `$inc` needed).
- Add the `epoch` claim to `WsTokenPayloadSchema`/`WsTokenClaims`, sign it at the
  Yjs-token mint (`page-collab.ts:88-92`), and regenerate OpenAPI artifacts
  (`pnpm check:openapi`).
- Enforce the epoch at `onAuthenticate` (reject `claims.epoch !==
  page.collabLifecycleVersion`) alongside the new deleted-status reject; record the
  page's epoch UNCONDITIONALLY at `onLoadDocument` in a sibling structure (§4.1.1).
- Fold `collabLifecycleVersion: expectedEpoch` (+ complementary `status: { $ne:
  STATUS_DELETED }`) into the atomic pointer CAS (`save-flow.ts:385-395`); make
  `onChange` stamp+guard the epoch, `onLoadDocument` replay only current-epoch
  rows, and `persistYjsState`/compaction write with an epoch filter (§4.2). These
  make rename/delete/revert write-correctness cross-replica at the durable write.
- Generalize the API invalidation helper to accept `InvalidateReason`
  (`invalidation.ts:39`).
- Fix the invalidator drain so stale connections remain reachable after registry
  detach, and add regression tests for the Hocuspocus 4 close path.
- Add typed invalidation options/callbacks to `Page.rename`, `Page.renameTree`,
  `Page.deletePage`, `Page.completelyDeletePage`, `Page.removePage`, and the
  removal wrappers (`skip` suppresses the prompt, NOT the epoch advance, §6.2).
- Place the `page-renamed` emit in `Page.rename` **before** the
  `createRedirectPage` branch (§6.1).
- Change `renameTree` / its executor to an allSettled-style typed result so
  successful page ids are reported (per-page epoch advance + emit already fire from
  `Page.rename`).
- Advance the epoch + emit `page-renamed`/`page-deleted` at the first durable
  lifecycle FIELD write (not on method resolution), so partial mutations still
  invalidate (§7.5).
- Add deleted-page materialization gates to Yjs-token issuance, WebSocket auth,
  and `onLoadDocument` (complementary to the epoch check).
- Purge collab lineage (`yjsState`/`yjsCheckpointAt` + `PageYjsUpdate`) at the
  soft-delete, hard-delete, and draft-cancel boundaries as defense-in-depth; re-run
  the idempotent purge in `revertDeletedPage` AFTER the status flip / internal
  rename (§7.4 step 6) to sweep pre-epoch rows and drain-window `onChange`
  stragglers (correctness is the epoch, §4.2).
- Preserve the existing web reload prompt behavior, including the per-descendant
  prompt for subtree renames (§7.6).
- Add focused model, save-flow (including the TOCTOU mid-save mutation case),
  subtree-child, handler, auth, load, invalidator, and lineage-purge tests.
- Update operator docs to state that the reload *prompt* is process-local for
  rename/delete while the *write* is safe on every replica.

### §15.2 Phase 2 — Cross-replica reload-prompt fanout

- Add a Redis pub/sub channel for collab lifecycle invalidation.
- Publish after the same committed mutation points used by Phase 1.
- Subscribe in every API process and call the local invalidator for incoming
  events (delivering the reload prompt to editors on non-mutating replicas).
- Add event id/origin metadata for idempotency and echo tolerance.
- Extend tests and operator docs for multi-instance deployments.

### §15.3 Phase 3 — UX refinements

- Add reason-specific copy to `CollabForceReloadDialog` if needed.
- Consider a separate, explicit rename navigation affordance after the user has
  acknowledged the prompt and recovery buffer state is safe.

## §16 Open Questions

No blocking design questions remain for Phase 1. The previously open write-safety
points are RESOLVED by the epoch:

- rename/delete/revert write-safety is closed cross-replica by folding
  `collabLifecycleVersion: expectedEpoch` into the ATOMIC pointer CAS (§4.1) and by
  checking the epoch at `onAuthenticate` (§5), so the durable write is the
  authority (no TOCTOU gap) AND a stale token is refused before it can load — the
  self-invalidating path-CAS is not used (§0.1, §14.3a);
- the expected epoch is server-recorded, per-replica, UNCONDITIONALLY at
  `onLoadDocument` in a sibling structure that the drain sentinel cannot skip
  (§4.1.1) — fixed by the design, NOT an open question;
- `onChange`/replay/checkpoint are epoch-conditional so stale-epoch collab state is
  non-replayable; the soft-delete boundary purge + revert re-purge are
  defense-in-depth, and correctness no longer depends on drain timing (§4.2, §7.1,
  §7.4);
- the epoch `$inc` rides the same `updateOne` as the lifecycle field, so partial
  mutations are write-safe at the field write; the rename emit fires at the durable
  `path` write before the redirect branch, per-page from `Page.rename`, including
  per descendant on a subtree rename (§6.1, §6.3, §7.5, §7.6, §8);
- `onLoadDocument` checks deleted status and records the epoch before materializing
  the Y.Doc (§5);
- hard delete and draft cancel synchronously remove `PageYjsUpdate` rows for
  privacy (§7.2-7.3).

New open questions introduced by the epoch (to DOCUMENT / decide at
implementation, not blocking the design):

- **Epoch field name.** `collabLifecycleVersion` vs a shorter `collabEpoch`. This
  RFC writes `collabLifecycleVersion` throughout; the shorter name is acceptable if
  the implementation prefers it, provided all four boundaries (Page field, token
  claim, `PageYjsUpdate` field, CAS predicate) use the one name.
- **wsToken payload back-compat for in-flight PRE-epoch tokens — PINNED:
  reject-and-remint.** A token minted just before rollout has no `epoch` claim.
  The rollout policy is DECIDED (not an open question): a token whose `epoch`
  claim is MISSING is REJECTED at `onAuthenticate`, exactly as an epoch mismatch
  is. It is NOT accepted-with-fallback. Accepting an epoch-less token and letting
  it load would make `onLoadDocument` record the POST-transition epoch as this
  replica's baseline, so the §4.1 CAS would then match — recreating, during the
  ~5-minute rollout window, the very path-CAS self-invalidation hole the epoch
  exists to close (§0.1). The rejection is transparent: the Hocuspocus provider's
  `onAuthenticationFailed` fires, `useCollabSession`'s bounded backoff calls
  `refetchToken()` (`CollaborativeMarkdownEditor.tsx:239`), and the api re-mints a
  FRESH token carrying the current `epoch` (or a 404 if the page is now deleted).
  Because wsTokens are 5-minutes-lived (`ws-token.ts:23`) and the provider
  proactively refreshes (`ws-token.ts:19-23`), the entire pre-epoch population
  cycles to epoch-bearing tokens within one TTL of deploy, at the cost of at most
  one silent reconnect per open editor. A hard cutover (schema requires `epoch`
  from day one, relying on the 5-minute TTL to drain pre-epoch tokens) is the
  equivalent acceptable alternative; the ONLY prohibited option is
  accept-epoch-less-with-fallback. The residual detail left to implementation is
  purely the schema mechanics: whether `WsTokenPayloadSchema` marks `epoch`
  `.optional()` for one release (reject at the hook when absent) then flips it to
  required, versus requiring it immediately — a payload-versioning choice, not a
  correctness choice, since both reject the epoch-less token.
- **Migration for existing Pages.** A one-time migration sets `collabLifecycleVersion:
  0` on all existing Page rows (the schema default also yields `0` for any row that
  slips through). This is a pure additive backfill with no data transformation.
  Decide whether to also run the optional one-time lineage cleanup for rows already
  in `STATUS_DELETED` (§7.1) in the same migration.
- **Existing `PageYjsUpdate` rows.** Rows created before the `collabLifecycleVersion`
  field exists have no epoch; they are treated as epoch `0` and simply not replayed
  once a page's epoch advances (and TTL-swept within an hour). No backfill is
  required (§4.2.1); document this as an accepted rollout behavior.
- **Phase-2 Redis prompt schema.** The channel name and payload
  (`{ pageIds, reason, originInstanceId, eventId }`) for the multi-replica reload-
  PROMPT fanout. Write-safety is already closed by the epoch; only the prompt to
  other-replica editors is deferred (§9, §15.2).

Remaining phase-scoped naming detail (document, not blocking):

- the exact TypeScript property names for the lifecycle invalidation options
  (`{ mode: 'emit' | 'skip'; reason; ... }` shape, §6.2/§7.2) and the concrete
  name of the sibling expected-epoch collection (its lifecycle contract is fixed by
  §4.1.1; only the identifier is open);
- whether Phase 3 should offer an explicit "open renamed page" action after the
  reload prompt.

## §17 References

- `packages/collab/src/invalidation.ts`
- `packages/collab/src/save-flow.ts`
- `packages/collab/src/hooks/on-load-document.ts`
- `packages/collab/src/hooks/on-authenticate.ts`
- `packages/collab/src/hooks/on-change.ts`
- `packages/collab/src/hooks/on-store-document.ts`
- `packages/collab/src/persist-yjs-state.ts`
- `packages/api/src/models/page.ts`
- `packages/api/src/models/page-yjs-update.ts`
- `packages/api/src/hono/handlers/page-collab.ts`
- `packages/api/src/hono/handlers/page.ts`
- `packages/api/src/hono/handlers/draft.ts`
- `packages/api/src/util/ws-token.ts`
- `packages/api-contract/src/schemas/collab.ts`
- `packages/api/src/collab/attach.ts`
- `packages/web/src/components/editor/render-mdast.ts`
- `packages/web/src/components/page-view/page-content.tsx`
- `packages/web/src/components/editor/MarkdownPreview.tsx`
- `docs/rfcs/0003-realtime-collaborative-editing.md`
- `docs/rfcs/0005-page-presence.md`
