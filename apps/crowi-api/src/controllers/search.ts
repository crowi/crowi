import { Request, Response } from 'express';
import type { SearchPageType, SearchQuery } from '@crowi/plugin-api';
import Crowi from 'src/crowi';
import ApiResponse from 'src/util/apiResponse';
import ApiPaginate from 'src/util/apiPaginate';
import { getAppContext } from 'src/util/view';
import { UserDocument } from 'src/models/user';
import Debug from 'debug';

const debug = Debug('crowi:routes:search');

const PAGE_TYPES: ReadonlySet<SearchPageType> = new Set(['portal', 'public', 'user']);

export default (crowi: Crowi) => {
  const Page = crowi.model('Page');
  const actions = {} as any;
  const api = (actions.api = {} as any);

  actions.searchPage = function (req: Request, res: Response) {
    const search = crowi.getSearcher();
    if (!search) {
      return res.json(ApiResponse.error('Search driver is not configured.'));
    }

    return res.json({ context: getAppContext(crowi, req) });
  };

  /**
   * @api {get} /search search page
   * @apiName Search
   * @apiGroup Search
   *
   * @apiParam {String} q keyword
   * @apiParam {String} path
   * @apiParam {String} offset
   * @apiParam {String} limit
   *
   * Bridge to the ts-rest SearchDriver. Once Task B (search ts-rest
   * route) lands, this legacy controller will be retired.
   */
  api.search = async function (req: Request, res: Response) {
    const user = req.user as UserDocument | undefined;
    const { q: keywordRaw, tree: treeRaw, type: typeRaw } = req.query;
    const keyword = typeof keywordRaw === 'string' ? keywordRaw : '';
    const tree = typeof treeRaw === 'string' ? treeRaw : null;
    const typeQuery = typeof typeRaw === 'string' ? typeRaw : null;

    let paginateOpts: { offset?: number; limit?: number } | undefined;
    try {
      paginateOpts = ApiPaginate.parseOptionsForElasticSearch(req.query);
    } catch (e) {
      return res.json(ApiResponse.error(e));
    }

    if (keyword === '') {
      return res.json(ApiResponse.error('keyword should not empty.'));
    }

    const search = crowi.getSearcher();
    if (!search) {
      return res.json(ApiResponse.error('Search driver is not configured.'));
    }

    const types: SearchPageType[] = typeQuery && PAGE_TYPES.has(typeQuery as SearchPageType) ? [typeQuery as SearchPageType] : [];
    const limit = paginateOpts?.limit ?? 50;
    const offset = paginateOpts?.offset ?? 0;
    const page = Math.floor(offset / Math.max(limit, 1)) + 1;

    const query: SearchQuery = {
      q: keyword,
      page,
      limit,
      ...(tree ? { pathPrefix: tree } : {}),
      ...(user ? { viewer: { id: String(user._id), username: user.username, isAdmin: !!user.admin } } : {}),
      ...(types.length > 0 ? { grants: { types } } : {}),
    };

    try {
      const { total, hits } = await search.query(query);
      const searchResult = hits.map((h) => ({ _id: h.id, _score: h.score, _source: { path: h.path } }));
      const pages = await Page.populatePageListToAnyObjects(searchResult);

      const data = pages
        .filter((page: Record<string, unknown>) => {
          if (Object.keys(page).length < 12) {
            // FIXME: 12 is a number of columns.
            return false;
          }
          return true;
        })
        .map((page: Record<string, unknown>) => {
          const source = page._source as { bookmark_count?: number } | undefined;
          return { ...page, bookmarkCount: source?.bookmark_count ?? 0 };
        });

      return res.json(ApiResponse.success({ meta: { total, results: hits.length }, searchResult, data }));
    } catch (err) {
      debug('Error on searching:', err);
      return res.json(ApiResponse.error(err));
    }
  };

  return actions;
};
