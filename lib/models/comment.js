module.exports = function(crowi) {
  const debug = require('debug')('crowi:models:comment')
  const mongoose = require('mongoose')
  const ObjectId = mongoose.Schema.Types.ObjectId
  const USER_PUBLIC_FIELDS = '_id image googleId name username email status createdAt' // TODO: どこか別の場所へ...
  const ObjectIdsUtil = require('../util/objectIds')
  const commentSchema = new mongoose.Schema({
    page: { type: ObjectId, ref: 'Page', index: true },
    creator: { type: ObjectId, ref: 'User', index: true },
    revision: { type: ObjectId, ref: 'Revision', index: true },
    comment: { type: String, required: true },
    commentPosition: { type: Number, default: -1 },
    createdAt: { type: Date, default: Date.now },
  })

  commentSchema.statics.create = function(pageId, creatorId, revisionId, comment, position) {
    var Comment = this
    var commentPosition = position || -1

    return new Promise(function(resolve, reject) {
      var newComment = new Comment()

      newComment.page = pageId
      newComment.creator = creatorId
      newComment.revision = revisionId
      newComment.comment = comment
      newComment.commentPosition = commentPosition

      newComment.save(function(err, data) {
        if (err) {
          debug('Error on saving comment.', err)
          return reject(err)
        }
        debug('Comment saved.', data)
        return resolve(data)
      })
    })
  }

  commentSchema.statics.getCommentsByPageId = function(id) {
    var self = this

    return new Promise(function(resolve, reject) {
      self
        .find({ page: id })
        .sort({ createdAt: -1 })
        .populate('creator', USER_PUBLIC_FIELDS)
        .exec(function(err, data) {
          if (err) {
            return reject(err)
          }

          if (data.length < 1) {
            return resolve([])
          }

          // debug('Comment loaded', data);
          return resolve(data)
        })
    })
  }

  commentSchema.statics.getCommentsByRevisionId = function(id) {
    var self = this

    return new Promise(function(resolve, reject) {
      self
        .find({ revision: id })
        .sort({ createdAt: -1 })
        .populate('creator', USER_PUBLIC_FIELDS)
        .exec(function(err, data) {
          if (err) {
            return reject(err)
          }

          if (data.length < 1) {
            return resolve([])
          }

          debug('Comment loaded', data)
          return resolve(data)
        })
    })
  }

  commentSchema.statics.countCommentByPageId = function(page) {
    var self = this

    return new Promise(function(resolve, reject) {
      self.count({ page: page }, function(err, data) {
        if (err) {
          return reject(err)
        }

        return resolve(data)
      })
    })
  }

  commentSchema.statics.removeCommentsByPageId = function(pageId) {
    var Comment = this

    return new Promise(function(resolve, reject) {
      Comment.remove({ page: pageId }, function(err, done) {
        if (err) {
          return reject(err)
        }

        resolve(done)
      })
    })
  }

  commentSchema.statics.findCreatorsByPage = function(page) {
    var Comment = this

    return new Promise(function(resolve, reject) {
      Comment.distinct('creator', { page: page }).exec(function(err, creaters) {
        if (err) {
          reject(err)
        }

        resolve(creaters)
      })
    })
  }

  commentSchema.methods.getNotificationTargetUsers = async function() {
    const Comment = this
    const Revision = crowi.model('Revision')
    const { page } = this

    const [commentCreators, revisionAuthors] = await Promise.all([Comment.findCreatorsByPage(page), Revision.findAuthorsByPage(page)])
    debug('commentCreators', commentCreators)
    debug('revisionAuthors', revisionAuthors)

    const targetUsers = ObjectIdsUtil.unique([...commentCreators, ...revisionAuthors])
    debug('targetUsers', targetUsers)

    return targetUsers
  }

  /**
   * post save hook
   */
  commentSchema.post('save', function(savedComment) {
    var Page = crowi.model('Page')
    var Comment = crowi.model('Comment')
    var Activity = crowi.model('Activity')

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

  return mongoose.model('Comment', commentSchema)
}
