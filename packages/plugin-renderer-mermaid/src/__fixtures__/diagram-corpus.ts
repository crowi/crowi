/**
 * Fixtures for the Phase 0 Node 24 compatibility spike
 * (.feature-state/specs/feature-plugin-renderer-mermaid.md §8).
 *
 * `DIAGRAM_CORPUS` holds one representative source per diagram type from
 * §8 A's required list (flowchart / sequence / class / state / ER /
 * journey / pie / git-graph). All 3 spike test files
 * (render-engine.spike.test.ts, render-engine.no-network.spike.test.ts,
 * render-engine.child-process-isolation.spike.test.ts) import this same
 * corpus so the "8 diagram types" gate is defined exactly once.
 */

export interface DiagramCorpusEntry {
  /** One of the 8 diagram types required by spec §8 A. */
  readonly name: string;
  /** A small but representative Mermaid source for that diagram type. */
  readonly source: string;
  /**
   * A source for the SAME diagram type (same recognized keyword on the
   * first line, so the type is not just "unparseable garbage" — it is
   * this specific grammar failing) that `mermaid.render()` deterministically
   * rejects with a parse/lexer error. Used by Phase 1's per-diagram-type
   * notation-error coverage (spec §1 AC: "8種それぞれについて...記法エラー系
   * ...をカバーする", `index.test.ts`). Each was verified empirically against
   * real `mermaid@11` output — Mermaid's per-diagram-type grammars differ
   * enough (several migrated to a different parser generator) that a single
   * generic corruption strategy does not reliably fail all 8, e.g. `state`
   * needed an unclosed composite-state block rather than the stray-bracket
   * corruption that works for the jison-based grammars.
   */
  readonly malformedSource: string;
}

export const DIAGRAM_CORPUS: readonly DiagramCorpusEntry[] = [
  {
    name: 'flowchart',
    source: ['flowchart TD', '  A[Start] --> B{Decision}', '  B -->|Yes| C[End]', '  B -->|No| D[Retry]', '  D --> A'].join('\n'),
    malformedSource: ['flowchart TD', '  A[Start --> B'].join('\n'),
  },
  {
    name: 'sequence',
    source: ['sequenceDiagram', '  participant Alice', '  participant Bob', '  Alice->>Bob: Hello Bob', '  Bob-->>Alice: Hi Alice'].join('\n'),
    malformedSource: ['sequenceDiagram', '  Alice ->->->-> Bob'].join('\n'),
  },
  {
    name: 'class',
    source: ['classDiagram', '  class Animal', '  Animal : +String name', '  Animal : +makeSound()', '  Animal <|-- Duck', '  Animal <|-- Cat'].join('\n'),
    malformedSource: ['classDiagram', '  class Animal {{{ ]]] broken'].join('\n'),
  },
  {
    name: 'state',
    source: ['stateDiagram-v2', '  [*] --> Still', '  Still --> Moving', '  Moving --> Still', '  Moving --> Crash', '  Crash --> [*]'].join('\n'),
    malformedSource: ['stateDiagram-v2', '  state Foo {', '  [*] --> Bar'].join('\n'), // unclosed composite-state block
  },
  {
    name: 'er',
    source: [
      'erDiagram',
      '  CUSTOMER ||--o{ ORDER : places',
      '  ORDER ||--|{ LINE-ITEM : contains',
      '  CUSTOMER {',
      '    string name',
      '    string custId',
      '  }',
    ].join('\n'),
    malformedSource: ['erDiagram', '  CUSTOMER }}}--{{{ broken'].join('\n'),
  },
  {
    name: 'journey',
    source: [
      'journey',
      '  title My working day',
      '  section Go to work',
      '    Make tea: 5: Me',
      '    Go upstairs: 3: Me',
      '  section At work',
      '    Do work: 1: Me',
    ].join('\n'),
    malformedSource: ['journey', '  section', '    ]]]broken[[[: not-a-number: Me'].join('\n'),
  },
  {
    name: 'pie',
    source: ['pie title Pets adopted by volunteers', '  "Dogs" : 42', '  "Cats" : 58'].join('\n'),
    malformedSource: ['pie', '  "Dogs" : not-a-number'].join('\n'),
  },
  {
    name: 'git-graph',
    source: ['gitGraph', '  commit', '  branch develop', '  checkout develop', '  commit', '  checkout main', '  merge develop', '  commit'].join('\n'),
    malformedSource: ['gitGraph', '  ]]]totally broken[[['].join('\n'),
  },
];

/**
 * §8 B diagnostic source — deliberately uses the flowchart "image shape"
 * data syntax (`@{ img: "..." }`), which spec §背景/§3(b) identifies as the
 * one Mermaid construct known to reach for a browser network API
 * (`new Image()` / `.src` / `.decode()`) *during* rendering, before any
 * SVG string exists to sanitize. Phase 1's §3(b) input-side rejection is
 * supposed to reject sources like this one before they ever reach
 * `renderMermaidSvg`; this fixture exists specifically to bypass that
 * (not-yet-implemented) rejection and hand the source directly to the
 * render call, so render-engine.no-network.spike.test.ts can prove the
 * instrumentation still catches the outbound-reach attempt as a second
 * layer of defense (§8 B).
 */
export const DIAGNOSTIC_IMAGE_SHAPE_SOURCE = ['flowchart TD', '  A@{ img: "https://example.invalid/pixel.png", label: "pic" }', '  A --> B'].join('\n');
