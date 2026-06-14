import { isObjectId, normalisePath, toPageQuery } from './page-ref';

/**
 * Unit coverage for the pure `<path-or-id>` resolution shared by the read and
 * write commands. The 24-hex/path distinction decides whether a reference is
 * sent as `page_id` or `path`, so it is locked here.
 */
describe('page-ref', () => {
  describe('isObjectId', () => {
    it('matches a bare 24-hex ObjectId (case-insensitive)', () => {
      expect(isObjectId('507f1f77bcf86cd799439011')).toBe(true);
      expect(isObjectId('507F1F77BCF86CD799439011')).toBe(true);
    });

    it('rejects paths and wrong-length hex', () => {
      expect(isObjectId('/foo/bar')).toBe(false);
      expect(isObjectId('507f1f77bcf86cd79943901')).toBe(false); // 23 chars
      expect(isObjectId('507f1f77bcf86cd799439011x')).toBe(false);
    });
  });

  describe('normalisePath', () => {
    it('adds a leading slash to a bare path', () => {
      expect(normalisePath('foo/bar')).toBe('/foo/bar');
    });

    it('leaves an already-absolute path untouched', () => {
      expect(normalisePath('/foo/bar')).toBe('/foo/bar');
    });
  });

  describe('toPageQuery', () => {
    it('routes a 24-hex arg to page_id', () => {
      expect(toPageQuery('507f1f77bcf86cd799439011')).toEqual({ page_id: '507f1f77bcf86cd799439011', revision_id: undefined });
    });

    it('routes a path arg to a normalised path', () => {
      expect(toPageQuery('foo/bar')).toEqual({ path: '/foo/bar', revision_id: undefined });
    });

    it('passes a revision id through on either branch', () => {
      expect(toPageQuery('foo', 'rev1')).toEqual({ path: '/foo', revision_id: 'rev1' });
      expect(toPageQuery('507f1f77bcf86cd799439011', 'rev1')).toEqual({ page_id: '507f1f77bcf86cd799439011', revision_id: 'rev1' });
    });
  });
});
