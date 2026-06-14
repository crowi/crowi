/**
 * `<path-or-id>` resolution shared by the read (`get`/`cat`) and write
 * (`edit`/`update`/`rm`/`mv`) commands. A page can be referenced either by
 * its slash path or by its bare 24-hex Mongo ObjectId; the API exposes both
 * (`path` vs `page_id`), so the CLI picks the right query field per argument.
 */

/**
 * A bare 24-hex Mongo ObjectId. A `<path-or-id>` argument that matches is
 * treated as a `page_id`; anything else is treated as a `path`.
 */
export const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/** Whether a `<path-or-id>` argument is a bare 24-hex ObjectId. */
export function isObjectId(value: string): boolean {
  return OBJECT_ID_RE.test(value);
}

/**
 * Normalise a bare path into a leading-slash path so `crowi get foo/bar`
 * behaves like `crowi get /foo/bar`. An ObjectId is returned untouched.
 */
export function normalisePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * Resolve the `<path-or-id>` positional into the `GetPageRequest` query
 * shape: a 24-hex string is sent as `page_id`, everything else as a
 * leading-slash `path`.
 */
export function toPageQuery(pathOrId: string, revisionId?: string): { path?: string; page_id?: string; revision_id?: string } {
  if (isObjectId(pathOrId)) {
    return { page_id: pathOrId, revision_id: revisionId };
  }
  return { path: normalisePath(pathOrId), revision_id: revisionId };
}
