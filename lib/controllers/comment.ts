import { Request, Response } from 'express'
import Crowi from 'server/crowi'
import ApiResponse from '../utils/apiResponse'
import { UserDocument } from 'server/models/user'

export default (crowi: Crowi) => {
  // var debug = Debug('crowi:routs:comment')
  const Comment = crowi.model('Comment')
  const actions = {} as any
  const api = {} as any

  actions.api = api

  /**
   * @api {get} /comments.get Get comments of the page of the revision
   * @apiName GetComments
   * @apiGroup Comment
   *
   * @apiParam {String} page_id Page Id.
   * @apiParam {String} revision_id Revision Id.
   */
  api.get = function(req: Request, res: Response) {
    const pageId = req.query.page_id
    const revisionId = req.query.revision_id

    if (revisionId) {
      return Comment.getCommentsByRevisionId(revisionId)
        .then(function(comments) {
          res.json(ApiResponse.success({ comments }))
        })
        .catch(function(err) {
          res.json(ApiResponse.error(err))
        })
    }

    return Comment.getCommentsByPageId(pageId)
      .then(function(comments) {
        res.json(ApiResponse.success({ comments }))
      })
      .catch(function(err) {
        res.json(ApiResponse.error(err))
      })
  }

  /**
   * @api {post} /comments.add Post comment for the page
   * @apiName PostComment
   * @apiGroup Comment
   *
   * @apiParam {String} page_id Page Id.
   * @apiParam {String} revision_id Revision Id.
   * @apiParam {String} comment Comment body
   * @apiParam {Number} comment_position=-1 Line number of the comment
   */
  api.add = async function(req: Request, res: Response) {
    const user = req.user as UserDocument

    if (!req.form.isValid) {
      return res.json(ApiResponse.error('Invalid comment.'))
    }

    const form = req.form.commentForm
    const page = form.page_id
    const creator = user._id
    const revision = form.revision_id
    const comment = form.comment
    const commentPosition = form.comment_position || undefined

    try {
      let createdComment = await Comment.create({ page, creator, revision, comment, commentPosition })
      createdComment = await createdComment.populate('creator').execPopulate()
      return res.json(ApiResponse.success({ comment: createdComment }))
    } catch (err) {
      return res.json(ApiResponse.error(err))
    }
  }

  return actions
}
