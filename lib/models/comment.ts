import Crowi from 'server/crowi'
import { Types, Document, Model, Schema, model } from 'mongoose'
import Debug from 'debug'

export interface CommentDocument extends Document {
  _id: Types.ObjectId
  page: Types.ObjectId | any
  creator: Types.ObjectId
  revision: Types.ObjectId
  comment: string
  commentPosition: number
  createdAt: Date
}
export interface CommentModel extends Model<CommentDocument> {
  getCommentsByPageId(id: Types.ObjectId): Promise<CommentDocument[]>
  getCommentsByRevisionId(id: Types.ObjectId): Promise<CommentDocument[]>
  countCommentByPageId(page: any): Promise<number>
  removeCommentsByPageId(pageId: Types.ObjectId): Promise<void>
  findCreatorsByPage(page: any): Promise<any[]>
}

export default (crowi: Crowi) => {
  const debug = Debug('crowi:models:comment')

  const commentSchema = new Schema<CommentDocument, CommentModel>({
    page: { type: Schema.Types.ObjectId, ref: 'Page', index: true },
    creator: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    revision: { type: Schema.Types.ObjectId, ref: 'Revision', index: true },
    comment: { type: String, required: true },
    commentPosition: { type: Number, default: -1 },
    createdAt: { type: Date, default: Date.now },
  })

  commentSchema.statics.getCommentsByPageId = function(id) {
    return Comment.find({ page: id })
      .sort({ createdAt: -1 })
      .populate('creator')
      .exec()
  }

  commentSchema.statics.getCommentsByRevisionId = function(id) {
    return Comment.find({ revision: id })
      .sort({ createdAt: -1 })
      .populate('creator')
      .exec()
  }

  commentSchema.statics.countCommentByPageId = function(page) {
    return Comment.countDocuments({ page }).exec()
  }

  commentSchema.statics.removeCommentsByPageId = async function(pageId) {
    await Comment.deleteMany({ page: pageId }).exec()
  }

  commentSchema.statics.findCreatorsByPage = function(page) {
    return Comment.distinct('creator', { page }).exec()
  }

  /**
   * post save hook
   */
  commentSchema.post('save', function(savedComment: CommentDocument) {
    const Page = crowi.model('Page')
    const Activity = crowi.model('Activity')

    Comment.countCommentByPageId(savedComment.page)
      .then(function(count) {
        return Page.updateCommentCount(savedComment.page, count)
      })
      .then(function(page) {
        debug('CommentCount Updated', page)
      })
      .catch(function() {})

    Activity.createByPageComment(savedComment)
      .then(function(activityLog) {
        debug('Activity created', activityLog)
      })
      .catch(function(err) {})
  })

  const Comment = model<CommentDocument, CommentModel>('Comment', commentSchema)

  return Comment
}
