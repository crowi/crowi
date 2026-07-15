import type { Link, Root, Text } from 'mdast';
import type { PluginLogger } from '@crowi/plugin-api';
import { createPipelineEsmDepsLoader, runPipeline } from '../pipeline';
import { RendererRegistryImpl } from '../registry';
import { makeMentionResolve, type MentionUsernameResolver } from './mention-resolve';

const silentLogger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const loadDeps = createPipelineEsmDepsLoader();

/**
 * Build a fresh mdast `link` node shaped exactly like `remarkMentions`
 * emits a mention: `data.hProperties.className === 'mention'`, single
 * `text` child `@username`.
 */
const mentionLink = (username: string): Link => ({
  type: 'link',
  url: `/user/${username}`,
  title: null,
  children: [{ type: 'text', value: `@${username}` }],
  data: { hProperties: { className: 'mention' } },
});

const paragraph = (...children: Array<Link | Text>): Root => ({
  type: 'root',
  children: [{ type: 'paragraph', children }],
});

describe('core/mention-resolve transform', () => {
  it('keeps a mention link whose username belongs to a real user', async () => {
    const resolver: MentionUsernameResolver = async () => new Set(['alice']);
    const tree = paragraph(mentionLink('alice'));

    await makeMentionResolve(resolver)(tree);

    const node = (tree.children[0] as { children: unknown[] }).children[0] as Link;
    expect(node.type).toBe('link');
    expect(node.url).toBe('/user/alice');
  });

  it('demotes a mention link for a non-existent username to plain text', async () => {
    const resolver: MentionUsernameResolver = async () => new Set();
    const tree = paragraph(mentionLink('ghost'));

    await makeMentionResolve(resolver)(tree);

    const node = (tree.children[0] as { children: unknown[] }).children[0] as Text;
    expect(node.type).toBe('text');
    expect(node.value).toBe('@ghost');
  });

  it('resolves a mix of real and unknown mentions, demoting only the unknowns', async () => {
    const resolver: MentionUsernameResolver = async (names) => new Set(names.filter((n) => n === 'alice'));
    const tree = paragraph(mentionLink('alice'), { type: 'text', value: ' and ' }, mentionLink('ghost'));

    await makeMentionResolve(resolver)(tree);

    const children = (tree.children[0] as { children: Array<Link | Text> }).children;
    expect(children[0].type).toBe('link');
    expect(children[2].type).toBe('text');
    expect((children[2] as Text).value).toBe('@ghost');
  });

  it('batch-resolves multiple mentions in a single resolver call (no per-mention N+1)', async () => {
    const resolver = jest.fn<Promise<Set<string>>, [string[]]>(async () => new Set(['alice', 'bob']));
    const tree = paragraph(mentionLink('alice'), { type: 'text', value: ' ' }, mentionLink('bob'), { type: 'text', value: ' ' }, mentionLink('carol'));

    await makeMentionResolve(resolver)(tree);

    expect(resolver).toHaveBeenCalledTimes(1);
    // The distinct usernames are passed in one batch.
    expect([...resolver.mock.calls[0][0]].sort()).toEqual(['alice', 'bob', 'carol']);
  });

  it('de-duplicates repeated usernames before resolving', async () => {
    const resolver = jest.fn<Promise<Set<string>>, [string[]]>(async () => new Set(['alice']));
    const tree = paragraph(mentionLink('alice'), { type: 'text', value: ' ' }, mentionLink('alice'));

    await makeMentionResolve(resolver)(tree);

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0][0]).toEqual(['alice']);
  });

  it('no-ops when the tree contains no mention links', async () => {
    const resolver = jest.fn<Promise<Set<string>>, [string[]]>(async () => new Set());
    const tree = paragraph({ type: 'text', value: 'plain text, no mentions' });

    await makeMentionResolve(resolver)(tree);

    expect(resolver).not.toHaveBeenCalled();
  });
});

describe('mention-resolve through runPipeline (save-mode)', () => {
  const run = async (body: string, resolver?: MentionUsernameResolver) => {
    const reg = new RendererRegistryImpl();
    return runPipeline(body, reg, { mode: 'save', log: silentLogger, actor: { kind: 'system' } }, loadDeps, {
      cache: undefined as never,
      pageId: null,
      resolveMentionUsernames: resolver,
    });
  };

  it('demotes an unknown @mention to plain text but keeps a real one', async () => {
    const resolver: MentionUsernameResolver = async (names) => new Set(names.filter((n) => n === 'alice'));
    const { tree } = await run('Hi @alice and @ghost!', resolver);

    const para = tree.children[0] as { children: Array<{ type: string; value?: string; url?: string }> };
    const link = para.children.find((c) => c.type === 'link');
    expect(link?.url).toBe('/user/alice');
    // The whole paragraph text once mentions are demoted/inlined.
    const flat = para.children.map((c) => (c.type === 'link' ? '@alice' : (c.value ?? ''))).join('');
    expect(flat).toContain('@ghost');
    expect(para.children.some((c) => c.type === 'link' && c.url === '/user/ghost')).toBe(false);
  });

  it('leaves metadata.mentions as the full set even when a username is unknown', async () => {
    const resolver: MentionUsernameResolver = async () => new Set(['alice']);
    const { metadata } = await run('Hi @alice and @ghost!', resolver);

    // metadata.mentions feeds the notification dispatch and must stay
    // all-mentions — only the rendered AST link nodes are demoted.
    expect(metadata.mentions.map((m) => m.username).sort()).toEqual(['alice', 'ghost']);
  });

  it('does not resolve in non-save modes (read keeps every mention link)', async () => {
    const resolver = jest.fn<Promise<Set<string>>, [string[]]>(async () => new Set());
    const reg = new RendererRegistryImpl();
    const { tree } = await runPipeline('Hi @ghost!', reg, { mode: 'read', log: silentLogger, actor: { kind: 'system' } }, loadDeps, {
      cache: undefined as never,
      pageId: null,
      resolveMentionUsernames: resolver,
    });

    expect(resolver).not.toHaveBeenCalled();
    const para = tree.children[0] as { children: Array<{ type: string; url?: string }> };
    expect(para.children.some((c) => c.type === 'link' && c.url === '/user/ghost')).toBe(true);
  });

  it('keeps every mention link when no resolver is supplied (pre-Phase-2 behaviour)', async () => {
    const { tree } = await run('Hi @ghost!');
    const para = tree.children[0] as { children: Array<{ type: string; url?: string }> };
    expect(para.children.some((c) => c.type === 'link' && c.url === '/user/ghost')).toBe(true);
  });
});
