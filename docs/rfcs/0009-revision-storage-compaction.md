# RFC-0009: Revision Storage Compaction

- **Status**: Design-complete (Round 4 — all open questions resolved)
- **Author**: (you)
- **Created**: 2026-05-28
- **Depends on**: RFC-0003 (Real-time Collaborative Editing), RFC-0002
  (Renderer / Plugin Architecture)
- **Related**: RFC-0008 (Migration Command Framework) — *not yet
  drafted; see "Migration"*

## Round 4 changes

Lineage: Round 1 draft → Round 2/3 implementation review (which
corrected the false "reuse RFC-0003's per-revision delta chain" premise
and reframed `renderedAst` as the primary storage lever) → Round 4, in
which the owner resolved all remaining open questions. The design is now
settled; remaining work is implementation plus a final code-integration
check (delegated to the implementation agent).

Resolutions and their consequences:

- **Delta representation = text-diff** (was OQ-A). per-character blame
  is out of scope, so the simpler representation wins. This dissolves
  the CRDT baseline problem and removes `yjsStateAtSnapshot` entirely.
  The schema, storage table, and replay description are simplified
  accordingly throughout.
- **renderedAst = snapshots only, option (B)** (was OQ-E). The primary
  storage lever. Incrementals regenerate on read via the existing
  parse-on-read fallback. *Still requires RFC-0002 owner acknowledgement
  as it revises RFC-0002's "AST on every revision" resolution — the
  owner here owns both, so this is a self-ack, but noted for the record.*
- **Cadence = elapsed-time gap of 15 min only** (was OQ-B). No
  session-end trigger (would either over-produce snapshots on trivial
  open-edit-close, or require async presence-layer coupling).
- **Safety valve = yes** (was OQ-C). Bound replay depth/size; also
  catches large single-save pastes (e.g. AI-generated Markdown pasted
  in to create a page).
- **Read refresh = synchronous, no SWR** (was OQ-D).
- **External-edit forced snapshot = not needed** (was OQ-F). With
  text-diff, deltas are Markdown-string patches and do not depend on
  Y.Doc baseline integrity, so an external/API edit that bypasses the
  Y.Doc layer needs no special re-baseline — the next save simply diffs
  against the previous body string.
- **Operator "compact now" = dropped** (was OQ-G). Operators have no
  way to detect which pages need it, and the safety valve handles deep
  chains automatically.

> Note on a related future feature (raised in design discussion):
> **range-anchored comments** (commenting on a text selection that must
> survive later edits) is *not* affected by this RFC. Anchor tracking
> belongs in the live Y.Doc layer (e.g. `Y.RelativePosition`), a
> different layer from how revision deltas are stored. Restoring comment
> anchors *across* historical revisions would be a separate RFC. text-
> diff here neither helps nor hinders it.

## Summary

Crowi stores every page revision as a full-text snapshot, plus a full
`renderedAst` (RFC-0002) on every save. For a frequently-edited page
this is wasteful: 100 revisions of a 10KB page cost ~1MB of
near-duplicate Markdown and ~3MB of near-duplicate `renderedAst`. This
RFC defines a **snapshot + incremental (text-diff)** storage scheme,
with `renderedAst` stored only on snapshots, to cut total storage by
roughly an order of magnitude.

The win comes from two levers:

1. **body compaction** — incrementals store a text patch from the
   parent instead of the full Markdown; and
2. **`renderedAst` placement** — stored only on snapshots; incrementals
   regenerate it on read. This is the larger lever, since `renderedAst`
   dominates total size.

Scope is limited to revisions created from v2.1 onward. Historical
v1.x revisions are not delta-compressed.

## Motivation

Every save writes the full Markdown body and a full `renderedAst`:

```
Revision { pageId, body: string (required), renderedAst, ... }  // every save
```

Costs:

1. **Storage** grows linearly with edit count even for tiny edits.
   Collaborative editing (RFC-0003) generates revisions quickly — a
   live meeting-minutes session can produce dozens of saves per hour.
2. The `renderedAst` JSON (~30KB typical) is several times larger than
   the `body` (~10KB), so it dominates, not the Markdown.
3. **Backup / replication** scale with the above.

RFC-0003 explicitly deferred this ("keep `body` and `renderedAst` on
every revision; optimise storage later"). This RFC is that deferred
work — informed by what the code actually does.

## Goals

- Materially reduce per-revision storage for revisions created from
  v2.1 onward, addressing both `body` and `renderedAst`.
- Align snapshot boundaries with natural editing-burst boundaries via
  an elapsed-time gap, not a blind save count.
- Keep historical reads **correct** (no approximate content), even if
  the first read of a cold revision is slower.
- Preserve RFC-0003's collaboration semantics (`savedBy`,
  `contributors`, save = checkpoint).
- Avoid any forced, high-risk migration of existing data on upgrade.

## Non-goals

- **Delta-compressing historical v1.x revisions.** Schema-unify at most,
  deferred to RFC-0008.
- **Per-character authorship / blame.** Out of scope; this is why
  text-diff (not Yjs-delta) was chosen.
- **Range-anchored comments across revisions.** Separate concern, live
  Y.Doc layer; see Round 4 note.
- **Changing what a "save" means.** RFC-0003 settled the checkpoint
  model.

## Design

### Storage foundation — current reality

The incremental payload cannot reuse "a per-revision delta chain
RFC-0003 already keeps" — no such chain exists:

- **`Page.yjsState`** (`models/page.ts:279`) — a single latest full
  Y.Doc snapshot per page, overwritten each save. No per-revision Y.Doc
  state.
- **`PageYjsUpdate`** — append log of inter-save deltas, TTL'd at 3600s
  and `deleteMany`'d on save (`collab/save-flow.ts:236-238`). Transient
  recovery buffer, not history.
- **`Revision.yjsUpdate`** (`models/revision.ts:225`) — schema field
  exists but nothing writes it; `prepareRevision` /
  `PrepareRevisionOptions` (`revision.ts:110`) take no delta; the save
  flow passes none (`save-flow.ts:169-175`).

A per-revision delta persistence path must therefore be built. Because
the chosen representation is **text-diff**, the delta is a Markdown
string patch — no Y.Doc binary baseline is involved.

### Delta representation: text-diff (decided)

incrementals store a text patch (e.g. `diff-match-patch` /
`fast-diff`) computed between the parent revision's Markdown and this
revision's Markdown. Replay applies the patch chain to the nearest
preceding snapshot's `body`.

Rationale: per-character blame is a non-goal, which was the only reason
to prefer Yjs-delta. text-diff is simpler, has no CRDT state-vector /
client-id baseline hazard, needs no per-snapshot Y.Doc binary, and is
the lightest on storage. (The unused `Revision.yjsUpdate` field can be
repurposed/renamed to a generic `delta`, or left unused and a new field
added — implementer's call.)

### Storage model: snapshot + incremental hybrid

```ts
Revision {
  _id, pageId,
  parentRevisionId: ObjectId | null,
  type: 'snapshot' | 'incremental',

  // type='snapshot': full Markdown
  body?: string,            // now OPTIONAL — see Schema changes

  // type='incremental': text patch from parent's Markdown
  delta?: string,

  // cadence safety-valve counters (denormalised; parent + 1 / + delta
  // size, reset to 0 at each snapshot) — keep the save-time type
  // decision O(1), no chain walk.
  chainDepth: number,
  chainBytes: number,

  // RFC-0002: present only on snapshots (option B)
  renderedAst: object | null,   // null/absent on incrementals
  rendererVersion: string,
  metadata: RevisionMetadata,

  // RFC-0003 (already implemented):
  savedBy: UserRef,
  contributors: UserRef[],
  createdAt: Date,
  message?: string,
}
```

- `snapshot` — stores full Markdown `body` and `renderedAst`.
- `incremental` — stores `delta` (text patch); no `body`, no
  `renderedAst`.

### Schema changes required

- **`body` must become optional.** Today
  `body: { type: String, required: true }` (`revision.ts:137`);
  `prepareRevision` always sets it (`revision.ts:289`). Relax `required`
  and add a `type` branch in `prepareRevision`.
- Add `delta` (string) for incrementals, plus `chainDepth` /
  `chainBytes` (number) carried on **every** revision so the
  safety-valve check is O(1) (parent value + 1 / + delta size; reset to
  0 at snapshots).
- `renderedAst` becomes conditional (snapshots only) — see "Interaction
  with renderedAst".
- **Read side is _not_ "mostly ready."** The `if (!body)` branch at
  `page-response.ts:167-172` only prevents a crash on a body-less
  revision; the real incremental read (patch replay → reconstruct
  Markdown → re-render) is unimplemented. New work spans the write path
  and this compound read path.

### Cadence — elapsed-time gap (15 min) + safety valve

Decided synchronously when a save arrives:

> When a save arrives:
> 1. If the gap since the previous save exceeds **15 minutes**, make
>    **this** save a `snapshot` (the previous burst is treated as
>    finished).
> 2. Else if the incremental chain since the last snapshot exceeds the
>    **safety-valve threshold** (depth or cumulative delta size), make
>    this save a `snapshot`.
> 3. Otherwise make it `incremental`.

The boundary is decided at the *head of the next burst* rather than the
*tail of the previous one* — which is what makes it compatible with
synchronous save-time evaluation (the "burst is over" fact is only
knowable from the next save's timing).

Behaviour:

- **Meeting-minutes burst**: saves land seconds/minutes apart, under
  15 min → a long incremental run, no wasted mid-burst snapshots.
- **After the burst**: someone reopens hours later and edits; that save
  exceeds 15 min → becomes a `snapshot`, cleanly re-baselining.
- **Large single-save paste** (e.g. AI-generated Markdown pasted to
  create/replace a page): produces a large delta; the safety valve
  trips and a `snapshot` is taken, keeping any chain shallow.
- **Very long uninterrupted burst** (gap never exceeds 15 min): the
  safety valve still bounds chain depth/size, so replay stays bounded.

No session-end (all-disconnected) trigger: it would either over-produce
snapshots on trivial open-edit-close, or require async presence-layer
coupling. Excluded from v1.

> **Safety-valve threshold (implementation-tunable, not a spec
> decision)**: suggested starting point — force a snapshot when the
> chain reaches ~50 incrementals OR cumulative delta size reaches one
> full-body-equivalent (~10KB). Tune against real data.

> **Cadence anchor**: needs only the **previous save's timestamp**,
> directly available via `parentRevisionId → createdAt` (or
> `Page.currentRevision`). No page-scoped counter is required — this
> avoids the path-based `findRevisionIdList` counting problem. The
> safety valve likewise needs **no chain walk**: each revision carries
> denormalised running totals (`chainDepth`, `chainBytes`) computed as
> `parent's value + 1` / `parent's value + this delta's size`, reset to
> `0` at every snapshot. The save-time decision reads only the parent
> revision (timestamp + these two counters), so it is **O(1)**
> regardless of how long the incremental chain has grown.

### Storage estimate

Illustrative page edited 100 times, assume cadence/safety-valve yield
~10 snapshots. Sizes: body ~10KB, text delta ~500B, renderedAst ~30KB.

| Component | v1.x / current | RFC-0009 (text-diff, AST on snapshots) |
|---|---|---|
| body | ~1MB (100×10KB) | ~100KB (10×10KB) |
| delta | — | ~45KB (90×500B) |
| renderedAst | ~3MB (100×30KB) | ~300KB (10×30KB) |
| **total** | **~4MB** | **~445KB** |

≈ **9x reduction**. Note the dominant saving is `renderedAst`
(3MB→300KB), not the body deltas — body-only compaction (deltas, AST
still on every revision) would have cut just ~21% (~4MB → ~3.15MB).

> Delta-size caveat: ~500B/delta is optimistic. Small edits with
> structural Markdown changes can produce larger patches. Treat totals
> as order-of-magnitude.

### Reading a revision (read-through, block-until-correct)

A cold read **blocks until the correct content is produced**. We never
return an approximate/stale revision while revalidating: a history
viewer showing "revision 45" must never momentarily render revision
44's content.

- `snapshot`: return `body` and stored `renderedAst` directly.
- `incremental`: from the nearest preceding `snapshot`'s `body`, apply
  the `delta` chain to reconstruct this revision's Markdown, then
  re-render via the existing parse-on-read fallback
  (`page-response.ts:159-185`). The first such read is the slow path
  (patch replay + re-render); the result should be cached/materialized
  so subsequent reads are fast.

This is a lazy-materialization / read-through cache shape. **SWR is not
adopted** — neither for body reconstruction (content-changing, must be
correct) nor, in v1, for renderer-version refresh (kept synchronous for
simplicity).

### Save flow (additions over RFC-0003)

```
(RFC-0003 steps 1–3: confirm Markdown, update Page.body, Page.yjsState)
4. if parentRevisionId == null            → type = 'snapshot'   // first revision: nothing to diff
   else:
     gap = now - parent.createdAt
     if (gap > 15min)
        OR (parent.chainDepth + 1   > maxDepth)
        OR (parent.chainBytes + deltaSize > maxBytes)
                                          → type = 'snapshot'
     else                                 → type = 'incremental'
5. snapshot:    persist body (+ renderedAst); chainDepth = chainBytes = 0
   incremental: persist delta = textDiff(parentBody, currentBody);
                chainDepth  = parent.chainDepth + 1
                chainBytes  = parent.chainBytes + deltaSize
6. parentRevisionId / savedBy / contributors   (already implemented)
7. renderedAst: write only when type == 'snapshot'
8. emit PageHtmlUpdated; notify other editors
```

Steps 4–5 and the conditional in 7 are new. Steps 6 and 8 already exist
in `save-flow.ts`. Step 4 reads only the parent revision (its
`createdAt` plus the denormalised `chainDepth` / `chainBytes`), so it is
**O(1)** — no chain walk. A `null` parent (first revision) is always a
`snapshot`.

## Interaction with renderedAst (RFC-0002) — decided: option (B)

`renderedAst` is stored **only on snapshot revisions**; incrementals
regenerate on read.

Current behaviour and affected code:

- `prepareRevision` (`revision.ts:308-314`) currently runs the renderer
  and stores `renderedAst` + `rendererVersion` on **every** revision,
  unconditionally — this must become conditional on `type`.
- `prepareRevision` is shared: `Page.createPage` / `Page.updatePage`
  also call it, so the change touches all callers, not just the collab
  path. (createPage/updatePage saves are typically snapshot-eligible
  anyway, but the conditional must be correct for all paths.)
- Reads already hybridise: `computeRevisionRenderArtifactsAsync`
  (`page-response.ts:159-185`) regenerates when `rendererVersion`
  mismatches or `renderedAst` is missing — so incrementals reusing this
  path need little new read-side machinery.

Note: the renderer still runs at save time on **every** revision — the
`meta` it produces (toc / wikiLinks / mentions / code-block langs,
consumed by backlinks / search / notify) comes from the same pipeline
pass (`revision.ts:312`). Option (B) therefore saves **storage, not
save-time CPU**, and an incremental's display AST is regenerated on read
— so an incremental is effectively rendered twice (once at save for
`meta`, once on first read for display). Acceptable because reads are
materialized (see "Reading a revision").

Trade-off accepted: historical incremental views show a **regenerated**
AST (current renderer) rather than the archived AST from save time. The
`rendererVersion` field governs correctness/consistency. The owner owns
both RFC-0002 and RFC-0009, so this revision of RFC-0002's "AST on
every revision" stance is self-acknowledged; recorded here for the log.

## Migration (historical v1.x revisions)

**No forced migration** on upgrade.

- **Phase A — v2.1 release**: no migration. v1.x revisions stay in the
  old shape; read paths handle both (already implemented). New
  revisions use the hybrid scheme.
- **Phase B — post-v2.1, optional, CURRENTLY BLOCKED**: a schema-unify
  pass adding `type: 'snapshot'` and `contributors: [savedBy]` to v1
  revisions. **RFC-0008's migration framework does not exist yet**
  (`docs/rfcs/0008-*.md` unwritten; `admin-cli`'s `migrate` is a
  single-purpose `--only=wikilink` implementation with no generic
  named-migration registry). The command below is aspirational until
  RFC-0008 lands. No delta-compression of historical data either way.
- **Phase C — distant future**: schema-unify may become required; v1.x
  read branch removed.

```bash
# Phase B — requires RFC-0008 framework first (not yet available)
crowi-admin migrate --only=revisions-schema-unify --dry-run
crowi-admin migrate --only=revisions-schema-unify
```

Rationale for not delta-compressing history: unpredictable runtime
(~1M docs, potentially hours), downtime/consistency risk, and minimal
benefit on rarely-viewed old revisions.

## What the RFC can rely on (review-confirmed)

- `savedBy` / `contributors` — collected from awareness and persisted
  (`save-flow.ts:148-162, 169-175`).
- `parentRevisionId` — set from
  `page.currentRevision ?? page.revision ?? null` (`save-flow.ts:165`);
  also the cadence anchor (its `createdAt`).
- `Page.currentRevision` pointer + old/new schema read fallback —
  implemented.
- "save = checkpoint" and current `type:'snapshot'` hard-coding
  (`save-flow.ts:173`) — stable; replacing this constant with the
  gap+safety-valve decision is the entry point for incrementals.

## Alternatives considered

- **Yjs-delta incrementals** — would preserve CRDT replay and enable
  per-character blame, but requires persisting per-snapshot Y.Doc
  binary baselines (`yjsStateAtSnapshot`) to avoid the client-id
  baseline hazard, costing more storage and complexity. Rejected
  because blame is a non-goal.
- **Fixed-count cadence (every Nth save)** — original design; ignores
  edit density (meeting-minutes pathology). Replaced by 15-min gap +
  safety valve.
- **Content-addressable blob store (sha256 dedup)** — strong for
  exact-repeat content; needs GC; complex. Deferred.
- **Keep `bodyAtSave` / renderedAst on incrementals** — negates the
  storage win; rejected (that is option A).
- **SWR for reads** — rejected for body (correctness) and deferred for
  renderer-version refresh (kept synchronous in v1).
- **Session-end snapshot trigger** — rejected for v1 (over-production
  or async presence coupling).
- **Operator "compact now" command** — dropped; no detection path for
  operators, and the safety valve automates deep-chain compaction.
- **External-edit forced re-baseline** — unnecessary with text-diff
  (no Y.Doc baseline dependency).

## Resolved decisions

1. Storage model: snapshot + incremental hybrid.
2. Delta representation: **text-diff** (per-character blame is a
   non-goal).
3. `renderedAst`: stored on **snapshots only** (option B); incrementals
   regenerate on read via the existing fallback.
4. Cadence: **15-minute elapsed-time gap**, decided synchronously at
   save time; the prior "every 10th revision" rule is withdrawn; no
   session-end trigger.
5. **Safety valve**: force a snapshot when the incremental chain exceeds
   a depth/size threshold (catches long bursts and large pastes).
   Tracked via denormalised `chainDepth` / `chainBytes` on each revision
   (parent + 1, reset at snapshots) so the check is O(1) — no chain
   walk. Threshold value is implementation-tunable.
6. Reads are **read-through, block-until-correct**; no SWR in v1.
7. No external-edit forced snapshot (not needed under text-diff).
8. No operator "compact now" command in v1.
9. No forced migration of v1.x revisions; staged Phase A/B/C;
   historical revisions schema-unified at most, never delta-compressed.

## Implementation notes / handoff

For the implementation agent to verify against current code:

- Make `Revision.body` optional and add a `delta` (string) field;
  decide whether to reuse/rename the unused `yjsUpdate` field.
- Add the `type` branch to the shared `prepareRevision` (write `body`+
  `renderedAst` for snapshots; write `delta` and skip `renderedAst` for
  incrementals); confirm all callers
  (`createPage`/`updatePage`/collab save) behave correctly.
- Implement the gap+safety-valve decision at the
  `save-flow.ts:173` hard-coded `type:'snapshot'` site: read the parent
  revision's `createdAt` + denormalised `chainDepth` / `chainBytes`
  (O(1), no chain walk); a `null` parent forces a `snapshot`.
- Persist `chainDepth` / `chainBytes` on every revision (parent value +
  1 / + delta size; reset to 0 on snapshots).
- Implement incremental read: patch replay from nearest snapshot →
  Markdown → reuse `computeRevisionRenderArtifactsAsync` for AST;
  add materialization/caching of the reconstructed result.
- Confirm the `if (!body)` read branch is upgraded from
  crash-avoidance to real replay.
- Leave v1.x revisions untouched; ensure dual-shape reads still pass.
