# RFC-0020: HTML Artifact Pages

- **Status**: Draft
- **Target**: v2
- **Owner**: Sotaro

## Summary

Crowi pages currently hold Markdown only. This RFC introduces a second page kind, the *artifact*, whose body is a single self-contained HTML document rendered inside a sandboxed iframe. Artifacts are written programmatically through the existing page API — by agents over MCP, and by people or scripts over the CLI — and read in the browser. What v1 withholds is an in-browser editing surface, not a class of author.

The motivating consumer already exists. Agents write documents into Crowi over MCP and those documents are read by humans, but prose is a poor medium for things that are inherently diagrammatic — architecture topologies, state machines, data relationships, comparison matrices. Today an agent that wants to explain a graph has to describe it in sentences that the reader must reassemble mentally. Letting the agent emit a rendered diagram instead removes that reassembly step entirely.

The entire security posture rests on one idea: an artifact must never execute in a security context that can reach Crowi. Everything below is either a mechanism for enforcing that or a consequence of it.

## Goals

- Store and serve agent-authored HTML documents as first-class Crowi pages, sharing the existing path namespace, ACL, revision history, rename and delete semantics.
- Execute artifact content in an isolated context that cannot read Crowi credentials, call Crowi APIs, or otherwise reach the Crowi origin. See *Delivery: response headers* for what this does and does not cover.
- Add no new collections and no new required schema fields, so that a future relational migration is not made harder by this feature.
- Fail loudly when the deployment is not configured to host artifacts safely, rather than silently degrading to an unsafe configuration.
- Remain deployable by a self-hosting operator who controls only a single domain.

## Non-goals

**Multi-file artifacts.** An artifact is one HTML document. There are no sibling assets, no relative-path resolution, and no directory semantics. A page path identifies exactly one document, as it does for Markdown.

**React and JSX artifacts.** Supporting them would require either browser-side transpilation, which mandates `'unsafe-eval'` in the artifact CSP and removes one of the sandbox's layers, or a build pipeline inside Crowi. Neither is justified here. The ergonomic value of a component framework is almost entirely about reducing the cognitive load of human authorship and maintenance; artifacts are machine-authored and typically short-lived, so that value does not accrue, while the costs do. A framework path would additionally bind Crowi to an external provider's library set — pinned versions of charting, icon and 3D libraries, and a prebuilt utility-class stylesheet — such that upstream changes silently break stored artifacts. Agents are instructed to emit plain HTML via the MCP tool description, and ingest rejects JSX payloads. See *Reversibility* for how this decision can be revisited without disturbing the rest of the design.

**In-browser editing.** Crowi's editing surface is the collaborative editor, and artifacts are not given one: no editor, no preview-and-save loop in the browser. Writes reach an artifact the way any programmatic client reaches a page — over MCP or the CLI — so what is excluded is a surface, not an author. This is a deferral rather than a rejection, but nothing in this RFC should be designed around a hypothetical editor.

**Concurrent editing.** Artifacts are not integrated with Yjs or Hocuspocus. Writes are whole-document replacements.

**Server-side execution.** Crowi never executes artifact content, never renders it headlessly, and never generates thumbnails or previews from it. Artifact HTML is opaque text to the server, subject only to structural validation.

**Artifact-to-Crowi interaction.** An artifact cannot read the current user, query pages, or call the Crowi API. Any such capability would require punching a hole in `connect-src`, which is the single most load-bearing directive in the policy below.

## Background

### What agents actually produce

Two distinct shapes exist in agent-produced "artifact" output, and only one of them is directly usable.

A plain HTML artifact is genuinely self-contained: markup, styles and scripts are inline in one file, and it runs by being handed to a browser. Nothing more is needed.

A component-framework artifact is a single file but is *not* self-contained. It exports a component and assumes an invisible surrounding harness that supplies transpilation, the framework runtime, a stylesheet, and resolution of bare module specifiers. That harness is the host's responsibility, and adopting it means adopting the host's library inventory and version pins as an ongoing obligation.

Consequently the storage model is a single HTML string, not an `html` / `css` / `js` triple. The triple corresponds to neither artifact shape, and inventing it would mean asking agents to decompose a document they already emit in one piece, then recomposing it on read.

### Why sandboxing must be about origin, not attributes

The `sandbox` iframe attribute is necessary but not sufficient. An iframe carrying `sandbox="allow-scripts"` without `allow-same-origin` already runs in an opaque origin, so the embedded case is well defended. The exposure is the *un-embedded* case: a user, or an attacker-supplied link, navigating a browser tab directly at the artifact's URL. That request has no iframe and therefore no sandbox attribute. If the response is served from the Crowi origin with a normal HTML content type, the artifact's scripts execute with full Crowi origin privileges — a stored cross-site scripting vulnerability with agent-controlled payload.

Everything in the delivery design follows from closing that specific hole.

## Architecture

### Request flow

```
                     Crowi origin                    Artifact origin
                  (session cookies)                  (no cookies ever)
                          |                                  |
  1. GET /path/to/page    |                                  |
  ------------------------>                                  |
     ACL check, resolve revision                             |
     mint signed token                                       |
  <------------------------                                  |
     page shell + <iframe src=...>                           |
                          |                                  |
  2. GET /a/{rev}?t={token}                                  |
  --------------------------------------------------------->|
                          |          verify HMAC, exp, revision match
                          |          serve stored HTML verbatim
                          |          + CSP, + sandbox, no Set-Cookie
  <---------------------------------------------------------|
                          |                                  |
  3. artifact executes in opaque origin                      |
     connect-src 'none'  -> no fetch anywhere                |
     no cookies present  -> nothing to steal                 |
     no allow-same-origin -> no DOM access to parent         |
```

### Storage

Artifacts reuse `pages` and `revisions` unchanged. A discriminator field selects the interpretation of the revision body:

```
Page     { path, type: 'markdown' | 'artifact', ... }   // denormalized copy
Revision { body, type: 'markdown' | 'artifact', ... }   // authoritative
```

`Revision.type` is authoritative because the type is a property of the stored bytes, not of the page. A page converted from Markdown to artifact still has Markdown in its older revisions; rendering history correctly requires reading the type from the revision being rendered. `Page.type` is a denormalized copy of the latest revision's type, maintained on write, existing so that listing and routing avoid a join.

Path uniqueness across Markdown and artifact pages is obtained for free, since both live in `pages` under the existing unique index on path. This is the primary reason for not introducing a separate collection: MongoDB cannot express a uniqueness constraint spanning two collections, so a split would require application-level checks with an unavoidable race window.

`renderedAst` does not exist for artifacts. There is no Markdown AST to derive, and the stored HTML is served verbatim.

### Interaction with RFC-0009

Artifacts participate in the snapshot-plus-incremental scheme without modification. Text diffing applies to HTML as readily as to Markdown, and because artifacts carry no `renderedAst`, snapshots are inherently light — the bulk of the storage reduction RFC-0009 achieves for Markdown comes from confining `renderedAst` to snapshots, and that cost is simply absent here.

One adjustment is required. RFC-0009's safety valve triggers on large pastes, which is a human-editing signal. Artifact writes are whole-document replacements rather than incremental edits, so a substantial fraction of artifact revisions will produce a diff comparable in size to a full snapshot, at which point storing a diff is pure overhead. The valve should therefore be generalised from a paste-size heuristic to a ratio test: when `len(diff) / len(body)` exceeds a threshold, write a snapshot regardless of chain depth or elapsed time. This generalisation is strictly an improvement for Markdown too, and is proposed as an amendment to RFC-0009 rather than as artifact-specific behaviour.

### Normalisation happens at ingest

Validation and normalisation run once, on write, and the result is what gets stored. Read is a byte-for-byte serve. This keeps artifacts free of derived data and makes the served bytes auditable. It does not make an artifact immune to a later policy change: the bytes never change, but what the browser is permitted to do with them is decided by the policy in force when the page is served. See *CDN allowlist* for where that boundary sits.

Ingest rejects, rather than sanitising:

- external script or stylesheet references whose origin is outside the CDN allowlist
- `<script type="text/babel">`, `type="text/jsx"`, or other transpiler-dependent script types
- bare module specifiers in `import` statements that no import map resolves
- references to relative paths, which cannot resolve since artifacts are single documents
- payloads exceeding the configured size limit

Rejection returns a structured error from the API, surfaced by whichever client made the write, so the author can correct and retry. Silent stripping is avoided deliberately: an agent that believes its chart library loaded, when it did not, produces a blank page and no diagnostic.

### Delivery: origin isolation

Two deployment modes are supported. The distinction is where artifacts are served from, and it is the operator's decision.

**Mode A — separate origin (recommended).** The operator sets `CROWI_ARTIFACT_ORIGIN` to a domain distinct from the Crowi origin. A wholly separate registrable domain is preferred over a subdomain, since a subdomain remains within reach of cookies scoped with an explicit `Domain=` attribute and shares the site for `SameSite` purposes. In this mode the artifact origin is a cookie-free zone: Crowi never issues a cookie for it, so direct navigation to an artifact URL — sandbox attribute or not — yields a document with no ambient authority and nothing to steal.

**Mode B — same origin with document-level sandboxing (permitted).** Requiring a second domain would put this feature out of reach for a large share of self-hosted deployments, which is not an acceptable outcome for a project whose primary distribution is self-hosting. Mode B therefore serves artifacts from the Crowi origin under a path prefix, and closes the direct-navigation hole by emitting `Content-Security-Policy: sandbox allow-scripts` on the artifact response. That header applies sandboxing to the document itself rather than to an embedding frame, forcing an opaque origin even when the URL is opened directly in a tab. Scripts still run; access to the Crowi origin's storage and cookies does not.

Mode B must be enabled explicitly by an administrator, and the admin UI must state its residual risk plainly. Requests are still transmitted with Crowi session cookies attached — the document cannot read them, but a reverse proxy or CDN that strips or overrides response headers removes the entire protection, and the failure is silent. Mode A has no equivalent single point of failure. Where an operator can obtain a second domain, they should.

Neither mode is the default. With no artifact origin configured and Mode B not explicitly enabled, artifact rendering is disabled: pages of type `artifact` display an explanatory notice instead of an iframe, and writes are rejected with a configuration error. There is no fallback to unsandboxed same-origin delivery under any circumstance.

### Delivery: authorisation without cookies

The artifact origin must not receive cookies, so access control cannot rely on them. Instead the Crowi origin performs the ACL check while rendering the page shell, then mints a short-lived token over the tuple `(pageId, revisionId, userId, exp)`, HMAC-signed and carried in the iframe URL.

The signing key is derived via HKDF from the application secret with an artifact-specific info string, and is not the raw JWT secret. Reusing a single secret across unrelated signing purposes was identified as a defect during RFC-0014 review; the same reasoning applies here.

Including `revisionId` in the URL makes responses immutable and cacheable, and makes the rendered content deterministic across reloads.

### Delivery: response headers

Artifact responses carry:

```
Content-Security-Policy:
  default-src 'none';
  script-src 'nonce-{n}' {cdn-allowlist};
  style-src  'nonce-{n}' {cdn-allowlist};
  img-src    data: blob:;
  font-src   {cdn-allowlist};
  connect-src 'none';
  frame-ancestors {crowi-origin};
  form-action 'none';
  base-uri 'none';
  sandbox allow-scripts;          # Mode B only
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Cache-Control: private, immutable
```

`connect-src 'none'` is the directive that matters most. With it in place, an artifact cannot call the Crowi API and cannot open a scripted connection to a third-party endpoint.

It does not, on its own, make an artifact incapable of exfiltration, and an earlier draft of this section overstated what it buys. Three channels survive it. A frame may navigate *itself* — `connect-src` does not govern navigation, `navigate-to` was dropped from CSP3 and never shipped, and no `sandbox` flag restricts a frame's navigation of its own browsing context; `allow-top-navigation` withholds only the *containing* tab. A subresource fetched from an allowlisted CDN carries whatever the artifact puts in its query string, so allowlisting an origin makes that origin's operator a recipient. And a request leaving the frame carries a `Referer` naming the artifact URL, which contains the signed token — a capability, not merely a location.

The first and third are closed: the third by `Referrer-Policy: no-referrer` above, the first by the shell policy below. The second is inherent to allowlisting an origin at all, which is why the allowlist ships empty and is populated deliberately by an administrator rather than seeded with a speculative default.

**The page shell restricts where its frame may go.** Sandboxing the artifact document does not constrain the artifact's own navigation, but the *embedding* document's `frame-src` does: a nested browsing context is checked against its parent's policy on every navigation, including ones the frame initiates for itself and any redirect that follows. The Crowi page shell therefore serves `Content-Security-Policy: frame-src {artifact-origin}`. A policy naming only `frame-src` enforces only `frame-src`, so this composes with the application's existing response headers without disturbing script or style handling. Without it, an artifact closes the loop with a single assignment to `location.href`.

That defence has one boundary worth stating rather than discovering. It exists only where there is a parent: a browser tab pointed directly at an artifact URL has no embedding document and therefore no `frame-src`. Mode A and Mode B already ensure such a tab holds no Crowi authority, so what remains at risk there is what the user types into that tab. The same boundary governs ordinary links: an `<a href>` to a third-party site is inert in the embedded case, where `frame-src` applies, and is an ordinary working link in a directly-opened tab, where nothing constrains it. Author-facing documentation should describe link behaviour as a property of the embedded case rather than of artifacts as such. **The guarantee this design makes is that an artifact cannot reach Crowi — its origin, its credentials, or its API. It is not a guarantee that an artifact cannot transmit what a user types into it, and the sandboxed-content indicator should not be read as promising one.**

`frame-ancestors` restricted to the Crowi origin prevents third-party sites from embedding artifacts and presenting them as their own.

### The page surface

An artifact page keeps the chrome of a Markdown page and replaces only the part that renders the body. Title, breadcrumb, author and timestamps, comments, likes, watch, share and history all behave as they do for Markdown, because none of them read the body. Treating that as the default — rather than designing a separate artifact page shell — is the decision here: an artifact is a page whose body renders differently, not a different kind of object.

**Width.** Markdown pages reserve a right rail for the table of contents and cap the body at a readable measure. Neither applies to an artifact. There is no heading structure to extract, so the rail has nothing to hold; and the width cap exists to keep prose lines readable, which is a property of prose rather than of a rendering surface. **Both go together.** Removing the rail alone would leave the artifact at the same capped width with empty space beside it, which is the worst of the two layouts. The artifact region therefore spans the body column and the rail together. It does not bleed to the viewport edge — the outer margins stay aligned with the rest of the application.

**Menu.** The page menu divides three ways rather than two.

- *Format-specific, hidden.* Copy markdown names a format the page does not have, and a whole HTML document on the clipboard has no destination a reader would paste it into.
- *Format-specific, substituted.* Download markdown becomes download HTML. The objection to the copy action does not apply here: the download names the format the page actually holds, and it is the reader's way to keep or inspect an artifact outside Crowi. **It must be served as an attachment.** Serving the stored HTML inline from the Crowi origin would render it in a context that can reach Crowi, which is the exact hole Mode A and Mode B exist to close — a download route that omits `Content-Disposition: attachment` reopens it while looking like a convenience feature.
- *Generic, kept.* History, rename, delete, like, watch, share, comments. These operate on the page, not the body.
- *Undefined, hidden.* Portalize. A portal is a page whose Markdown body introduces an index of its children; what an artifact body means in that position has never been defined. It is hidden because the semantics are absent, not because they were considered and rejected — if a use emerges, define the behaviour first and then surface the action.

**Title.** An artifact must have a title, as any page must. This is not a new artifact-specific rule and needs no new enforcement: it is the existing page requirement, and ingest adds nothing on top of it.

### Marking artifacts in page lists

A reader scanning a list should be able to tell an artifact from a Markdown page before opening it.

The list row already has a vocabulary for this, and it distinguishes two things. **An icon states what a page is** — a compass for a portal, a link for link-only sharing, a lock for a private page — while **a coloured pill states what state a page is in**, as draft and deleted do. Being an artifact is a kind, not a state: it is intrinsic, permanent, and not a stage the page passes through. **It therefore takes an icon, in the same muted treatment as its neighbours.** A pill would place artifacts in the draft-and-deleted bucket and imply the page is in some temporary condition.

The glyph is `layout-freeform`. What separates an artifact from a Markdown page, for someone about to click it, is that it composes its own layout: a Markdown page is always the same single column, and an artifact is whatever it arranges itself to be. That is the quality the icon should carry.

Glyphs shaped like documents — a book, a scroll — were passed over because every page is a document, so they distinguish nothing. Glyphs describing the mechanism, such as circuitry for "scripts run here", do distinguish, but on a wiki they can be read as describing the page's *subject* rather than its kind; the neighbouring compass, link and lock have no such ambiguity, because each of them names what the page is rather than how it works.

`layout-freeform` was added in lucide 1.27, and the codebase is on 0.x. **Phase 4 therefore depends on the lucide major upgrade**, or must ship an interim glyph and swap it afterwards. This is a scheduling constraint rather than a design one, but it should not be discovered during implementation.

### Delivery: embedding

The page shell embeds the artifact with `sandbox="allow-scripts"` and nothing else. Three omissions are deliberate:

`allow-same-origin` is omitted because combining it with `allow-scripts` permits a same-origin document to remove its own sandboxing, which would defeat the mechanism in Mode B entirely.

`allow-top-navigation` is omitted so that an artifact cannot redirect the containing tab, which would otherwise make artifacts a convenient phishing vector inside a trusted wiki.

`allow-forms` and `allow-popups` are omitted for the same reason.

The practical cost is that `localStorage` and `sessionStorage` are unavailable inside artifacts. This is not a meaningful loss for the target use case, and agent-authored artifacts are already conventionally written without browser storage.

### CDN allowlist

Artifacts may load scripts, styles and fonts from an allowlist of origins maintained by an administrator. **It ships empty.** Nothing is allowlisted until someone decides to allowlist it, because an allowlisted origin is a party that receives whatever an artifact puts in a request to it, and that is a decision an operator should make rather than inherit. `esm.sh` and `cdn.jsdelivr.net` are offered in the admin UI as one-click entries — a suggestion an operator accepts, not a default they must discover and remove.

The cost of the empty default is real but bounded: a self-contained artifact — inline markup, styles and scripts, which is what agents emit by default — needs no allowlist at all. What an empty allowlist withholds is the large charting and visualisation libraries that are impractical to inline.

Allowlist entries are matched by origin. Ingest validation and the delivery CSP read the same configuration value, so the two agree at any single moment. That agreement is a property of one instant, not a guarantee that holds over time, and an earlier draft of this section overstated it into one.

Two things break the stronger reading. An allowlist is mutable while stored bytes are not, so removing an origin blocks subresources in artifacts that were accepted while it was allowed. And ingest can only enumerate what is statically visible in the document — a URL assembled at runtime, a stylesheet's own `url()` references, or a module a permitted module imports in turn are all beyond it.

**The CSP is the enforcement boundary. Ingest is a fast-fail diagnostic for the authoring agent** — it catches, at write time and with a message the agent can act on, the mistakes that are cheap to catch, so that the common case fails in the place where it can be fixed rather than silently in a viewer's browser. Its enumeration is best-effort by design, and calling it anything stronger would misplace where the security actually lives.

One operational consequence follows. Narrowing the allowlist can break artifacts that already exist, so the admin UI must say so at the point of removal rather than leaving an operator to discover it from a blank frame.

### Execution is user-initiated

Artifacts do not auto-execute on page load. The shell renders a placeholder with title and metadata, and the iframe is created on explicit user action. This bounds the damage from a runaway artifact — an accidental infinite loop or an unbounded allocation degrades one deliberately opened tab rather than every page view — and it means listing or linking an artifact never executes it.

The shell displays a persistent indicator that the frame contains sandboxed, agent-authored content, so that a user cannot mistake artifact-rendered chrome for Crowi's own interface.

## Resolved decisions

**A single HTML string, not an html/css/js triple.** The triple matches neither shape of real agent output and would require decomposition on write and recomposition on read.

**No new collections and no new required fields.** A discriminator on `Revision`, denormalised to `Page`, is the entire schema change. Path uniqueness, ACL, rename, delete and history all continue to work without modification. A relational migration remains a `pages` → `revisions` foreign key; nullable-column sprawl and key-less embedded documents, which are the actual sources of pain in such a migration, are avoided.

**`Revision.type` is authoritative.** Type is a property of the stored bytes. Deriving it from `Page` alone would render historical revisions with the wrong renderer after a type conversion.

**Ingest-time normalisation, verbatim read.** Keeps artifacts free of derived data and makes served bytes auditable.

**Reject rather than sanitise.** Silent stripping produces silent breakage that the authoring agent cannot diagnose.

**`connect-src 'none'` is non-negotiable.** It is the directive that makes the CDN allowlist safe, and no artifact-side feature justifying its relaxation has been identified.

**Mode A recommended, Mode B permitted, neither default.** Absent explicit configuration, artifacts do not render. Unsandboxed same-origin delivery is never reachable by configuration.

**Signing key derived via HKDF, not the raw application secret.** Consistent with the finding in RFC-0014 review.

**No React or JSX.** See Non-goals.

**The CDN allowlist ships empty.** Populating it speculatively would allowlist recipients no operator chose. Suggested entries are offered in the admin UI instead.

**Fully-qualified CDN URLs only.** Import maps and bare specifiers are rejected at ingest. Validation stays exact, and the requirement is stated in the MCP tool description and the CLI's help text.

**Artifacts are indexed by path and title only.** Indexing raw markup would pollute results with tag noise, and extracting text implies parsing and therefore derived data. Restricting indexing to fields every search driver already handles keeps Mongo and external backends behaviourally identical.

**No in-place conversion between Markdown and artifact.** Create selects the kind; update preserves it. The revision model handles conversion correctly, but the operation has no demonstrated use, and permitting it would put mixed-kind history in front of every reader of a page's timeline.

**A distinct size limit, not the Markdown one.** The two bodies have unrelated size distributions. The starting values are a 2 MiB default with a 10 MiB configurable maximum, measured over the normalised UTF-8 bytes.

**A disabled deployment shows a notice and an attachment-only download.** Not a raw source view: rendering stored HTML as text in the page is a rendering decision that invites the same mistakes the delivery design exists to prevent, and the download route already has to exist for the page menu.

## Reversibility

The React exclusion is deliberately structured to be reversible without touching the delivery, storage or CSP design. Should a case for it emerge, the sound path is to transpile and bundle at ingest, on the server, and store the resulting single HTML document. The stored artifact would then be indistinguishable from a hand-emitted one; delivery, CSP, sandboxing and RFC-0009 integration would all be unaffected. Build cost is incurred once per write rather than once per view, and build failure surfaces as a fail-fast ingest rejection with a diagnostic the authoring agent can act on. Nothing in this RFC should be designed in a way that forecloses that option, and equally nothing should be built in anticipation of it.

## Open questions

None outstanding. The six questions this RFC carried in draft — allowlist contents, import maps, size limit, search indexing, type conversion, and the disabled-deployment surface — are recorded under *Resolved decisions*.

## Implementation plan

**Phase 1 — Storage.** Add the type discriminator to `Revision` and `Page`, maintain the denormalised copy on write, and route rendering by revision type so that historical revisions display correctly. No delivery path yet.

**Phase 2 — Ingest.** Validation and normalisation, the allowlist configuration value, structured rejection errors, and the MCP tool with a description that specifies the expected output shape, with that same shape documented on the CLI's write path. At the end of this phase artifacts can be stored and their source inspected, but not executed.

**Phase 3 — Delivery.** The artifact serving route, signed-URL minting and verification, response headers, and Mode A / Mode B configuration with the startup check that disables the feature when neither is configured.

**Phase 4 — Shell.** The page-level rendering surface: placeholder, explicit execution control, sandboxed indicator, revision navigation. Also the surrounding chrome — the widened layout that drops the table-of-contents rail and the body width cap together, the menu with format-specific and undefined actions hidden, the HTML download served as an attachment, and the artifact icon in page lists.

**Phase 5 — RFC-0009 amendment.** Generalise the snapshot safety valve from a paste-size heuristic to a diff-to-body ratio test. Separable from the phases above and beneficial to Markdown independently.

Phase 5 is sequenced after the others rather than alongside them, because the compaction behaviour it amends is not yet implemented; a specification written against absent code would describe a baseline that does not exist.
