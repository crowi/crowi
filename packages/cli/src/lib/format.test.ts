import { applyTemplate, FORMAT_MODES, renderTable, resolveFormat } from './format';
import { CliError } from './http';

/**
 * Unit coverage for the list-output formatting helpers (`--format` /
 * `--template`). These drive the scriptable output contract for `search` /
 * `ls`, so the precedence rules and the tiny template language are locked.
 */
describe('format', () => {
  describe('resolveFormat', () => {
    it('defaults to human when nothing is set', () => {
      expect(resolveFormat({})).toBe('human');
    });

    it('maps the --json global to json mode', () => {
      expect(resolveFormat({ json: true })).toBe('json');
    });

    it('honours an explicit --format', () => {
      expect(resolveFormat({ format: 'table' })).toBe('table');
    });

    it('lets --template imply template mode and override --json', () => {
      expect(resolveFormat({ template: '{{path}}', json: true })).toBe('template');
    });

    it('rejects an unknown --format', () => {
      expect(() => resolveFormat({ format: 'yaml' })).toThrow(CliError);
    });

    it('rejects --template combined with a non-template --format', () => {
      expect(() => resolveFormat({ format: 'table', template: '{{path}}' })).toThrow(CliError);
    });

    it('lists the supported modes', () => {
      expect(FORMAT_MODES).toContain('human');
      expect(FORMAT_MODES).toContain('json');
      expect(FORMAT_MODES).toContain('table');
      expect(FORMAT_MODES).toContain('template');
    });
  });

  describe('applyTemplate', () => {
    it('substitutes flat fields', () => {
      expect(applyTemplate('{{path}}', { path: '/a/b' })).toBe('/a/b');
    });

    it('walks dotted field paths', () => {
      expect(applyTemplate('{{page.path}}', { page: { path: '/x' } })).toBe('/x');
    });

    it('renders missing fields as empty', () => {
      expect(applyTemplate('{{path}}-{{nope}}', { path: '/a' })).toBe('/a-');
    });

    it('expands \\t and \\n escapes and keeps literal text', () => {
      expect(applyTemplate('{{path}}\\t{{score}}', { path: '/a', score: 0.5 })).toBe('/a\t0.5');
    });

    it('JSON-stringifies object cells', () => {
      expect(applyTemplate('{{meta}}', { meta: { a: 1 } })).toBe('{"a":1}');
    });

    it('flattens newlines/tabs inside a field VALUE to a single line (FIX 5)', () => {
      // A field value with an embedded newline + tab must not break the
      // one-line-per-record contract; the template literal's own \t separator
      // (applied before substitution) is preserved.
      expect(applyTemplate('{{path}}\\t{{snippet}}', { path: '/a', snippet: 'line one\nline\ttwo' })).toBe('/a\tline one line two');
    });
  });

  describe('renderTable', () => {
    it('aligns columns with a header row', () => {
      const out = renderTable(
        [
          { path: '/a', count: 2 },
          { path: '/longer', count: 10 },
        ],
        ['path', 'count'],
      );
      const lines = out.split('\n');
      expect(lines[0]).toBe('path     count');
      expect(lines[1]).toBe('/a       2');
      expect(lines[2]).toBe('/longer  10');
    });

    it('flattens an embedded newline/tab in a cell so column alignment survives (FIX 5)', () => {
      const out = renderTable([{ path: '/a', snippet: 'multi\nline\tcell' }], ['path', 'snippet']);
      const lines = out.split('\n');
      // One header + exactly one data row — the embedded newline did NOT
      // spill the cell into extra rows.
      expect(lines).toHaveLength(2);
      expect(lines[1]).toBe('/a    multi line cell');
    });
  });
});
