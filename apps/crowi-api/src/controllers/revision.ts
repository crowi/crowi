import { Request, Response } from 'express';
import Crowi from 'src/crowi';
import Debug from 'debug';
import ApiResponse from 'src/util/apiResponse';
import { getQueryAsString } from 'src/types/express';
import { Types } from 'mongoose';

export default (crowi: Crowi) => {
  const debug = Debug('crowi:routes:revision');
  const Page = crowi.model('Page');
  const Revision = crowi.model('Revision');
  const actions = {} as any;
  actions.api = {} as any;

  /**
   * @api {get} /revisions.get Get revision
   * @apiName GetRevision
   * @apiGroup Revision
   *
   * @apiParam {String} revision_id Revision Id.
   */
  actions.api.get = function (req: Request, res: Response) {
    const revisionId = getQueryAsString(req.query.revision_id);
    if (!revisionId) {
      return res.json(ApiResponse.error('Parameter revision_id is required.'));
    }

    // @ts-ignore - TypeScriptの型定義が正しくないため無視
    Revision.findRevision(new Types.ObjectId(revisionId))
      .then(function (data) {
        const result = {
          revision: data,
        };
        return res.json(ApiResponse.success(result));
      })
      .catch(function (err) {
        return res.json(ApiResponse.error(err));
      });
  };

  /**
   * @api {get} /revisions.ids Get revision id list of the page
   * @apiName ids
   * @apiGroup Revision
   *
   * @apiParam {String} page_id      Page Id.
   */
  actions.api.ids = function (req: Request, res: Response) {
    const pageId = req.query.page_id || null;

    if (pageId && crowi.isPageId(pageId)) {
      Page.findPageByIdAndGrantedUser(pageId, req.user)
        .then(function (pageData) {
          debug('Page found', pageData._id, pageData.path);
          return Revision.findRevisionIdList(pageData.path);
        })
        .then(function (revisions) {
          return res.json(ApiResponse.success({ revisions }));
        })
        .catch(function (err) {
          return res.json(ApiResponse.error(err));
        });
    } else {
      return res.json(ApiResponse.error('Parameter error.'));
    }
  };

  /**
   * @api {get} /revisions.list Get revisions
   * @apiName ListRevision
   * @apiGroup Revision
   *
   * @apiParam {String} revision_ids Revision Ids.
   * @apiParam {String} page_id      Page Id.
   */
  actions.api.list = function (req: Request, res: Response) {
    const revisionIds = getQueryAsString(req.query.revision_ids);

    if (!revisionIds) {
      return res.json(ApiResponse.error('Parameter revision_ids is required.'));
    }

    // @ts-ignore - TypeScriptの型定義が正しくないため無視
    const arrayRevisionIds = revisionIds.split(',').map((id) => new Types.ObjectId(id));

    Revision.findRevisions(arrayRevisionIds)
      .then(function (revisions) {
        return res.json(ApiResponse.success({ revisions }));
      })
      .catch(function (err) {
        return res.json(ApiResponse.error(err));
      });
  };

  return actions;
};
