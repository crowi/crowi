module.exports = function(crowi) {
  const debug = require('debug')('crowi:models:bookmark')
  const mongoose = require('mongoose')
  const ObjectId = mongoose.Schema.Types.ObjectId
  const bookmarkEvent = crowi.event('bookmark')
  const bookmarkSchema = new mongoose.Schema({
    page: { type: ObjectId, ref: 'Page', index: true },
    user: { type: ObjectId, ref: 'User', index: true },
    createdAt: { type: Date, default: Date.now() },
  })
  bookmarkSchema.index({ page: 1, user: 1 }, { unique: true })

  bookmarkSchema.statics.populatePage = function(bookmarks, requestUser) {
    var Bookmark = this

    requestUser = requestUser || null

    return Bookmark.populate(bookmarks, { path: 'page' })
      .then(function(bookmarks) {
        return Bookmark.populate(bookmarks, { path: 'page.revision', model: 'Revision' })
      })
      .then(function(bookmarks) {
        // hmm...
        bookmarks = bookmarks.filter(function(bookmark) {
          // requestUser を指定しない場合 public のみを返す
          if (requestUser === null) {
            return bookmark.page.isPublic()
          }

          return bookmark.page.isGrantedFor(requestUser)
        })

        return Bookmark.populate(bookmarks, { path: 'page.revision.author', model: 'User' })
      })
  }

  // bookmark チェック用
  bookmarkSchema.statics.findByPageIdAndUserId = function(pageId, userId) {
    var Bookmark = this

    return new Promise(function(resolve, reject) {
      return Bookmark.findOne({ page: pageId, user: userId }, function(err, doc) {
        if (err) {
          return reject(err)
        }

        return resolve(doc)
      })
    })
  }

  bookmarkSchema.statics.findByUserId = function(userId, option) {
    var Bookmark = this

    var limit = option.limit || 50
    var offset = option.offset || 0

    var finder = new Promise(function(resolve, reject) {
      Bookmark.find({ user: userId })
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .exec(function(err, bookmarks) {
          if (err) {
            return reject(err)
          }

          return Bookmark.populatePage(bookmarks).then(resolve)
        })
    })

    var counter = new Promise(function(resolve, reject) {
      Bookmark.count({ user: userId }).exec(function(err, count) {
        if (err) {
          return reject(err)
        }

        return resolve(count)
      })
    })

    return Promise.all([finder, counter])
      .then(function([bookmarks, count]) {
        return {
          meta: {
            total: count,
            limit: limit,
            offset: offset,
          },
          data: bookmarks,
        }
      })
      .catch(function(err) {
        debug('err', err)
        throw err
      })
  }

  // bookmark count
  bookmarkSchema.statics.countByPageId = async function(pageId) {
    const Bookmark = this
    const count = await Bookmark.count({ page: pageId })

    return count
  }

  /**
   * option = {
   *  limit: Int
   *  offset: Int
   *  requestUser: User
   * }
   */
  bookmarkSchema.statics.findByUser = function(user, option) {
    var Bookmark = this
    var requestUser = option.requestUser || null

    var limit = option.limit || 50
    var offset = option.offset || 0
    var populatePage = option.populatePage || false

    return new Promise(function(resolve, reject) {
      Bookmark.find({ user: user._id })
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .exec(function(err, bookmarks) {
          if (err) {
            return reject(err)
          }

          if (!populatePage) {
            return resolve(bookmarks)
          }

          return Bookmark.populatePage(bookmarks, requestUser).then(resolve)
        })
    })
  }

  bookmarkSchema.statics.add = async function(page, user) {
    const Bookmark = this

    const newBookmark = new Bookmark({ page, user, createdAt: Date.now() })

    try {
      const bookmark = await newBookmark.save()
      bookmarkEvent.emit('create', page._id)
      return bookmark
    } catch (err) {
      if (err.code === 11000) {
        // duplicate key (dummy response of new object)
        return newBookmark
      }
      debug('Bookmark.save failed', err)
      throw err
    }
  }

  bookmarkSchema.statics.removeBookmarksByPageId = async function(pageId) {
    const Bookmark = this

    try {
      const data = await Bookmark.remove({ page: pageId })
      bookmarkEvent.emit('delete', pageId)
      return data
    } catch (err) {
      debug('Bookmark.remove failed (removeBookmarkByPage)', err)
      throw err
    }
  }

  bookmarkSchema.statics.removeBookmark = async function(page, user) {
    const Bookmark = this

    try {
      const data = await Bookmark.findOneAndRemove({ page, user })
      bookmarkEvent.emit('delete', page)
      return data
    } catch (err) {
      debug('Bookmark.findOneAndRemove failed', err)
      throw err
    }
  }

  return mongoose.model('Bookmark', bookmarkSchema)
}
