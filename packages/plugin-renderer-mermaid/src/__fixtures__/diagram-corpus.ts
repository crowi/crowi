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
}

export const DIAGRAM_CORPUS: readonly DiagramCorpusEntry[] = [
  {
    name: 'flowchart',
    source: ['flowchart TD', '  A[Start] --> B{Decision}', '  B -->|Yes| C[End]', '  B -->|No| D[Retry]', '  D --> A'].join('\n'),
  },
  {
    name: 'sequence',
    source: ['sequenceDiagram', '  participant Alice', '  participant Bob', '  Alice->>Bob: Hello Bob', '  Bob-->>Alice: Hi Alice'].join('\n'),
  },
  {
    name: 'class',
    source: ['classDiagram', '  class Animal', '  Animal : +String name', '  Animal : +makeSound()', '  Animal <|-- Duck', '  Animal <|-- Cat'].join('\n'),
  },
  {
    name: 'state',
    source: ['stateDiagram-v2', '  [*] --> Still', '  Still --> Moving', '  Moving --> Still', '  Moving --> Crash', '  Crash --> [*]'].join('\n'),
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
  },
  {
    name: 'pie',
    source: ['pie title Pets adopted by volunteers', '  "Dogs" : 42', '  "Cats" : 58'].join('\n'),
  },
  {
    name: 'git-graph',
    source: ['gitGraph', '  commit', '  branch develop', '  checkout develop', '  commit', '  checkout main', '  merge develop', '  commit'].join('\n'),
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
