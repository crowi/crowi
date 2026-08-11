import { FRONTMATTER_MAX_KEY_CHARS, FRONTMATTER_MAX_RAW_BYTES, FRONTMATTER_MAX_VALUE_CHARS } from '@crowi/api-contract';
import type { Root, RootContent } from 'mdast';
import { createEmptyPipelineMetadata } from '../pipeline';
import { makeFrontmatterPlugin } from './frontmatter';

/** Fresh, empty `PipelineMetadata` — this transform doesn't aggregate into it, but the plugin factory signature requires one. */
const emptyMetadata = createEmptyPipelineMetadata;

function run(tree: Root): void {
  makeFrontmatterPlugin(emptyMetadata())(tree);
}

/** Synthesize the `yaml` node `remark-frontmatter` would hand this transform — delimiters and one leading/trailing EOL already stripped (see `frontmatter.ts`'s `YamlNode` doc comment). */
function yamlNode(value: string, position?: RootContent['position']): RootContent {
  return { type: 'yaml', value, ...(position ? { position } : {}) } as unknown as RootContent;
}

function paragraph(text: string): RootContent {
  return { type: 'paragraph', children: [{ type: 'text', value: text }] } as unknown as RootContent;
}

function root(...children: RootContent[]): Root {
  return { type: 'root', children };
}

type CrowiFrontmatterEntry = { key: string; value: string };
type CrowiFrontmatterOut = { type: 'crowiFrontmatter'; entries: CrowiFrontmatterEntry[]; position?: unknown };
type CodeOut = { type: 'code'; lang?: string | null; meta?: string | null; value: string; position?: unknown };

describe('core/frontmatter transform', () => {
  it('replaces a leading yaml node with crowiFrontmatter for a simple key: value block (AC-1 unit slice)', () => {
    const tree = root(yamlNode('id: feature-foo\nstatus: approved'), paragraph('body'));
    run(tree);

    expect(tree.children).toHaveLength(2);
    const fm = tree.children[0] as unknown as CrowiFrontmatterOut;
    expect(fm.type).toBe('crowiFrontmatter');
    expect(fm.entries).toEqual([
      { key: 'id', value: 'feature-foo' },
      { key: 'status', value: 'approved' },
    ]);
    expect(tree.children[1]).toEqual(paragraph('body'));
  });

  it('leaves a thematicBreak (a mid-document `---`) completely untouched (AC-2)', () => {
    // This is what the tree looks like AFTER `remark-frontmatter` has
    // already correctly classified a mid-document `---` as an ordinary
    // `thematicBreak` (only a LINE-1 `---` ever becomes a `yaml` node —
    // see `frontmatter.ts`'s module doc comment). This transform must
    // not special-case `thematicBreak` in any way. The full parser-level
    // guarantee is covered end-to-end in `pipeline.test.ts`.
    const thematicBreak = { type: 'thematicBreak' } as unknown as RootContent;
    const tree = root(paragraph('above'), thematicBreak, paragraph('below'));
    run(tree);
    expect(tree.children).toEqual([paragraph('above'), thematicBreak, paragraph('below')]);
  });

  it('folds an indented continuation line and a `- ` list line into the previous entry, joined by a single space (AC-3)', () => {
    const raw = ['tags:', '  - a', '  - b', 'description: multi', '  line continuation'].join('\n');
    const tree = root(yamlNode(raw));
    run(tree);

    const fm = tree.children[0] as unknown as CrowiFrontmatterOut;
    expect(fm.entries).toEqual([
      { key: 'tags', value: '- a - b' },
      { key: 'description', value: 'multi line continuation' },
    ]);
  });

  it('folds an unindented `- ` list line into the previous entry too (AC-3, no-indent variant)', () => {
    const raw = ['tags:', '- a', '- b'].join('\n');
    const tree = root(yamlNode(raw));
    run(tree);

    const fm = tree.children[0] as unknown as CrowiFrontmatterOut;
    expect(fm.entries).toEqual([{ key: 'tags', value: '- a - b' }]);
  });

  it('folds an unindented `- ` list line into the previous entry even when it contains its own colon (AC-3, list-of-mappings variant)', () => {
    const raw = ['tags:', '- name: value'].join('\n');
    const tree = root(yamlNode(raw));
    run(tree);

    const fm = tree.children[0] as unknown as CrowiFrontmatterOut;
    expect(fm.entries).toEqual([{ key: 'tags', value: '- name: value' }]);
  });

  it('discards a continuation line with no entry open yet', () => {
    const raw = ['  orphan continuation', 'key: value'].join('\n');
    const tree = root(yamlNode(raw));
    run(tree);
    const fm = tree.children[0] as unknown as CrowiFrontmatterOut;
    expect(fm.entries).toEqual([{ key: 'key', value: 'value' }]);
  });

  it('trims leading/trailing whitespace off both key and value', () => {
    const tree = root(yamlNode('key   :   value with spaces   '));
    run(tree);
    const fm = tree.children[0] as unknown as CrowiFrontmatterOut;
    expect(fm.entries).toEqual([{ key: 'key', value: 'value with spaces' }]);
  });

  it('falls back to a `code` (lang: yaml) node, preserving the full raw text untruncated, when the raw block exceeds 8 KiB (AC-4)', () => {
    const raw = `key: ${'x'.repeat(FRONTMATTER_MAX_RAW_BYTES)}`;
    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(FRONTMATTER_MAX_RAW_BYTES);
    const tree = root(yamlNode(raw));
    run(tree);

    expect(tree.children).toHaveLength(1);
    const code = tree.children[0] as unknown as CodeOut;
    expect(code.type).toBe('code');
    expect(code.lang).toBe('yaml');
    expect(code.value).toBe(raw); // byte-identical — never truncated
  });

  it('falls back to a code node when entry count exceeds 50, without truncating any entry (AC-5)', () => {
    const lines = Array.from({ length: 51 }, (_, i) => `key${i}: value${i}`);
    const raw = lines.join('\n');
    const tree = root(yamlNode(raw));
    run(tree);
    const code = tree.children[0] as unknown as CodeOut;
    expect(code.type).toBe('code');
    expect(code.value).toBe(raw);
  });

  it('falls back to a code node when a key exceeds 100 chars, without truncating (AC-5)', () => {
    const longKey = 'k'.repeat(FRONTMATTER_MAX_KEY_CHARS + 1);
    const raw = `${longKey}: value`;
    const tree = root(yamlNode(raw));
    run(tree);
    const code = tree.children[0] as unknown as CodeOut;
    expect(code.type).toBe('code');
    expect(code.value).toBe(raw);
  });

  it('falls back to a code node when a value exceeds 300 chars, without truncating (AC-5)', () => {
    const longValue = 'v'.repeat(FRONTMATTER_MAX_VALUE_CHARS + 1);
    const raw = `key: ${longValue}`;
    const tree = root(yamlNode(raw));
    run(tree);
    const code = tree.children[0] as unknown as CodeOut;
    expect(code.type).toBe('code');
    expect(code.value).toBe(raw);
  });

  it('falls back to a code node when zero `key: value` lines can be extracted from a non-empty block (AC-6)', () => {
    const raw = ['not a key value line', 'still no colon here'].join('\n');
    const tree = root(yamlNode(raw));
    run(tree);
    expect(tree.children).toHaveLength(1);
    const code = tree.children[0] as unknown as CodeOut;
    expect(code.type).toBe('code');
    expect(code.lang).toBe('yaml');
    expect(code.value).toBe(raw);
  });

  it('removes the node entirely for an empty frontmatter block (`---` immediately followed by `---`) (AC-7)', () => {
    const tree = root(yamlNode(''), paragraph('body'));
    run(tree);
    expect(tree.children).toEqual([paragraph('body')]);
  });

  it('carries a value containing `*` and `[` through verbatim, as plain data — never reinterpreted (AC-9)', () => {
    const tree = root(yamlNode('note: *starred* and [bracketed]'));
    run(tree);
    const fm = tree.children[0] as unknown as CrowiFrontmatterOut;
    expect(fm.entries).toEqual([{ key: 'note', value: '*starred* and [bracketed]' }]);
  });

  it('copies `position` from the source yaml node onto the crowiFrontmatter replacement (editor preview scroll-sync)', () => {
    const position = { start: { line: 1, column: 1, offset: 0 }, end: { line: 3, column: 4, offset: 20 } };
    const tree = root(yamlNode('key: value', position));
    run(tree);
    const fm = tree.children[0] as unknown as CrowiFrontmatterOut;
    expect(fm.position).toEqual(position);
  });

  it('copies `position` from the source yaml node onto the code fallback replacement', () => {
    const position = { start: { line: 1, column: 1, offset: 0 }, end: { line: 3, column: 4, offset: 20 } };
    const tree = root(yamlNode('not key value at all', position));
    run(tree);
    const code = tree.children[0] as unknown as CodeOut;
    expect(code.position).toEqual(position);
  });
});
