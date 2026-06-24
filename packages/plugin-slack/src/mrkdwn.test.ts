import { markdownToMrkdwn } from './mrkdwn';

const BASE = 'https://wiki.example.com';

describe('markdownToMrkdwn', () => {
  it('bolds ATX headings (any level, optional closing #s)', () => {
    expect(markdownToMrkdwn('# Onboarding')).toBe('*Onboarding*');
    expect(markdownToMrkdwn('### Deep dive')).toBe('*Deep dive*');
    expect(markdownToMrkdwn('## Closed ##')).toBe('*Closed*');
  });

  it('does not treat a mid-line # as a heading', () => {
    expect(markdownToMrkdwn('see issue #42 now')).toBe('see issue #42 now');
  });

  it('normalises -, * and + bullets to • and preserves indent', () => {
    expect(markdownToMrkdwn('- a\n* b\n+ c')).toBe('• a\n• b\n• c');
    expect(markdownToMrkdwn('  - nested')).toBe('  • nested');
  });

  it('converts absolute links to Slack <url|label>', () => {
    expect(markdownToMrkdwn('[Crowi](https://crowi.wiki)')).toBe('<https://crowi.wiki|Crowi>');
  });

  it('resolves site-relative links against baseUrl', () => {
    expect(markdownToMrkdwn('[docs](/team/handbook)', { baseUrl: BASE })).toBe('<https://wiki.example.com/team/handbook|docs>');
  });

  it('keeps only the label for relative links when baseUrl is absent', () => {
    expect(markdownToMrkdwn('[docs](/team/handbook)')).toBe('docs');
  });

  it('keeps only the label for non-http links (anchors, mailto)', () => {
    expect(markdownToMrkdwn('[jump](#section)')).toBe('jump');
    expect(markdownToMrkdwn('[mail](mailto:a@b.com)')).toBe('mail');
  });

  it('drops images down to their alt text (before the link rule)', () => {
    expect(markdownToMrkdwn('![a logo](https://x/y.png)')).toBe('a logo');
    expect(markdownToMrkdwn('see ![](https://x/y.png) here')).toBe('see  here');
  });

  it('converts **bold** and __bold__ to mrkdwn *bold*', () => {
    expect(markdownToMrkdwn('this is **important**')).toBe('this is *important*');
    expect(markdownToMrkdwn('this is __also__')).toBe('this is *also*');
  });

  it('leaves single-marker emphasis and inline code for Slack to parse', () => {
    expect(markdownToMrkdwn('_italic_ and *one* and `code`')).toBe('_italic_ and *one* and `code`');
  });

  it('drops fenced-code markers but keeps the inner lines', () => {
    expect(markdownToMrkdwn('```js\nconst x = 1;\n```')).toBe('const x = 1;');
    expect(markdownToMrkdwn('~~~\nplain\n~~~')).toBe('plain');
  });

  it('returns empty for empty / whitespace-only input', () => {
    expect(markdownToMrkdwn('')).toBe('');
    expect(markdownToMrkdwn('   \n  ')).toBe('   \n  ');
  });

  it('handles a realistic mixed body', () => {
    const md = ['# Onboarding', '', 'Welcome! See the [handbook](/team/handbook).', '', '- step one', '- step two'].join('\n');
    expect(markdownToMrkdwn(md, { baseUrl: BASE })).toBe(
      ['*Onboarding*', '', 'Welcome! See the <https://wiki.example.com/team/handbook|handbook>.', '', '• step one', '• step two'].join('\n'),
    );
  });
});
