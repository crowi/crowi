import { buildSearchBody, GRANT_PUBLIC, defaultKeywordQueryFields, defaultPhraseQueryFields } from '../query-builder';
import { parseQuery } from '../parse-query';

const baseArgs = {
  parsed: parseQuery(''),
  from: 0,
  size: 50,
};

describe('buildSearchBody', () => {
  it('emits no _type or doc-type-prefixed fields (ES9 compat)', () => {
    const body = buildSearchBody({ ...baseArgs, parsed: parseQuery('hello'), viewer: { id: 'u1', username: 'alice' } });
    const wire = JSON.stringify(body);
    expect(wire).not.toContain('"_type"');
    expect(wire).not.toContain('"pages"');
  });

  it('combines keywords / phrases with bool must / must_not', () => {
    const body = buildSearchBody({
      ...baseArgs,
      parsed: parseQuery('hello world "exact phrase" -nope -"never"'),
      viewer: { id: 'u1', username: 'alice' },
    });
    const bool = (body.query as { bool: Record<string, unknown[]> }).bool;

    expect(bool.must).toContainEqual({
      multi_match: { query: 'hello world', fields: defaultKeywordQueryFields, operator: 'and' },
    });
    expect(bool.must).toContainEqual({
      multi_match: { type: 'phrase', query: 'exact phrase', fields: defaultPhraseQueryFields, operator: 'and' },
    });
    expect(bool.must_not).toContainEqual({
      multi_match: { query: 'nope', fields: defaultKeywordQueryFields, operator: 'or' },
    });
    expect(bool.must_not).toContainEqual({
      multi_match: { type: 'phrase', query: 'never', fields: defaultPhraseQueryFields, operator: 'or' },
    });
  });

  describe('grant filter', () => {
    it('limits anonymous viewers to public pages', () => {
      const body = buildSearchBody({ ...baseArgs, parsed: parseQuery('q') });
      const bool = (body.query as { bool: Record<string, unknown> }).bool;
      expect(bool.filter).toEqual(expect.arrayContaining([{ match: { grant: GRANT_PUBLIC } }]));
    });

    it('lets admins see everything (no grant filter clauses)', () => {
      const body = buildSearchBody({
        ...baseArgs,
        parsed: parseQuery('q'),
        viewer: { id: 'u1', username: 'admin', isAdmin: true },
      });
      const bool = (body.query as { bool: Record<string, unknown> }).bool;
      const filter = (bool.filter as unknown[]) ?? [];
      expect(filter.find((c) => JSON.stringify(c).includes('grant'))).toBeUndefined();
      expect(filter.find((c) => JSON.stringify(c).includes('granted_users'))).toBeUndefined();
    });

    it('non-admin sees public OR own-username OR shared-via-granted_users', () => {
      const body = buildSearchBody({
        ...baseArgs,
        parsed: parseQuery('q'),
        viewer: { id: 'user-id-123', username: 'alice' },
      });
      const bool = (body.query as { bool: Record<string, unknown> }).bool;
      const grantClause = (bool.filter as Array<{ bool?: { should: unknown[] } }>).find((c) => c.bool?.should);
      expect(grantClause).toBeDefined();
      expect(grantClause!.bool!.should).toEqual([
        { term: { grant: GRANT_PUBLIC } },
        { term: { username: 'alice' } },
        { term: { granted_users: 'user-id-123' } },
      ]);
    });
  });

  describe('type filter', () => {
    it('portal: must_not user-path + filter portal regex', () => {
      const body = buildSearchBody({ ...baseArgs, parsed: parseQuery(''), grants: { types: ['portal'] } });
      const bool = (body.query as { bool: Record<string, unknown[]> }).bool;
      expect(bool.must_not).toContainEqual({ prefix: { 'path.raw': '/user/' } });
      expect(bool.filter).toContainEqual({ regexp: { 'path.raw': '.*/' } });
    });

    it('public: must_not both user-path and portal-suffix path', () => {
      const body = buildSearchBody({ ...baseArgs, parsed: parseQuery(''), grants: { types: ['public'] } });
      const bool = (body.query as { bool: Record<string, unknown[]> }).bool;
      expect(bool.must_not).toEqual(expect.arrayContaining([{ prefix: { 'path.raw': '/user/' } }, { regexp: { 'path.raw': '.*/' } }]));
    });

    it('user: filter user-path prefix', () => {
      const body = buildSearchBody({ ...baseArgs, parsed: parseQuery(''), grants: { types: ['user'] } });
      const bool = (body.query as { bool: Record<string, unknown[]> }).bool;
      expect(bool.filter).toContainEqual({ prefix: { 'path.raw': '/user/' } });
    });

    it('multiple types are OR-combined via nested bool should', () => {
      const body = buildSearchBody({ ...baseArgs, parsed: parseQuery(''), grants: { types: ['portal', 'user'] } });
      const bool = (body.query as { bool: Record<string, unknown[]> }).bool;
      const orClause = (bool.filter as Array<{ bool?: { should?: unknown[] } }>).find((c) => c.bool?.should);
      expect(orClause).toBeDefined();
      expect((orClause!.bool!.should as unknown[]).length).toBe(2);
    });
  });

  it('appends pathPrefix as a wildcard filter and strips trailing slash', () => {
    const body = buildSearchBody({ ...baseArgs, parsed: parseQuery(''), pathPrefix: '/team/eng/' });
    const bool = (body.query as { bool: Record<string, unknown[]> }).bool;
    expect(bool.filter).toContainEqual({ wildcard: { 'path.raw': '/team/eng/*' } });
  });

  it('wraps base query with function_score when functionScore is set', () => {
    const body = buildSearchBody({
      ...baseArgs,
      parsed: parseQuery('q'),
      functionScore: {
        fieldValueFactor: { field: 'bookmark_count', modifier: 'log1p', factor: 1, missing: 0 },
        boostMode: 'sum',
      },
    });
    expect(body.query).toHaveProperty('function_score');
    const fs = (body.query as { function_score: Record<string, unknown> }).function_score;
    expect(fs.field_value_factor).toEqual({ field: 'bookmark_count', modifier: 'log1p', factor: 1, missing: 0 });
    expect(fs.boost_mode).toBe('sum');
  });

  it('ships highlight config so query() can derive snippet', () => {
    const body = buildSearchBody({ ...baseArgs, parsed: parseQuery('q') });
    expect(body.highlight).toMatchObject({
      pre_tags: ['<mark>'],
      post_tags: ['</mark>'],
      fields: { 'body.ja': {}, body: {} },
    });
  });

  it('paging sets from / size verbatim', () => {
    const body = buildSearchBody({ parsed: parseQuery(''), from: 100, size: 25 });
    expect(body).toMatchObject({ from: 100, size: 25 });
  });
});
