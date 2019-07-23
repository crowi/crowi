import * as mongoose from 'mongoose'
import Debug from 'debug'

type ObjectId = mongoose.Types.ObjectId
export interface BookmarkDocument extends mongoose.Document {
  page: ObjectId | any,
  user: ObjectId | any,
  createdAt: Date,
}
export interface BookmarkModel extends mongoose.Model<BookmarkDocument> {
  populatePage(bookmarks: any[], requestUser?: any): Promise<BookmarkDocument[]>
  findByPageIdAndUserId(pageId: ObjectId, userId: ObjectId): Promise<BookmarkDocument | null>
  findByUserId(userId: ObjectId, option: any): Promise<{
    meta: {
      total: any,
      limit: any,
      offset: any,
    },
    data: any
  }>
  countByPageId(pageId: ObjectId): Promise<number>
  findByUser(user: any, option: any): Promise<BookmarkDocument[]>
  add(page: any, user: any): Promise<BookmarkDocument>
  removeBookmarksByPageId(pageId: ObjectId): any
  removeBookmark(page: any, user: any): any
}

export default (crowi) => {
  const debug = Debug('crowi:models:Bookmark')
  const ObjectId = mongoose.Schema.Types.ObjectId
  const BookmarkEvent = crowi.event('Bookmark')
  const BookmarkSchema = new mongoose.Schema<BookmarkDocument, BookmarkModel>({
    page: { type: ObjectId, ref: 'Page', index: true },
    user: { type: ObjectId, ref: 'User', index: true },
    createdAt: { type: Date, default: Date.now() },
  })
  BookmarkSchema.index({ page: 1, user: 1 }, { unique: true })

  BookmarkSchema.statics.populatePage = function(Bookmarks, requestUser) {
    var Bookmark = this

    requestUser = requestUser || null

    return Bookmark.populate(Bookmarks, { path: 'page' })
      .then(function(Bookmarks) {
        return Bookmark.populate(Bookmarks, { path: 'page.revision', model: 'Revision' })
      })
      .then(function(Bookmarks) {
        // hmm...
        Bookmarks = Bookmarks.filter(function(Bookmark) {
          // requestUser を指定しない場合 public のみを返す
          if (requestUser === null) {
            return Bookmark.page.isPublic()
          }

          return Bookmark.page.isGrantedFor(requestUser)
        })

        return Bookmark.populate(Bookmarks, { path: 'page.revision.author', model: 'User' })
      })
  }

  // Bookmark チェック用
  BookmarkSchema.statics.findByPageIdAndUserId = function(pageId, userId) {
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

  BookmarkSchema.statics.findByUserId = function(userId, option) {
    var Bookmark = this

    var limit = option.limit || 50
    var offset = option.offset || 0

    var finder = new Promise(function(resolve, reject) {
      Bookmark.find({ user: userId })
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .exec(function(err, Bookmarks) {
          if (err) {
            return reject(err)
          }

          return Bookmark.populatePage(Bookmarks).then(resolve)
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
      .then(function([Bookmarks, count]) {
        return {
          meta: {
            total: count,
            limit: limit,
            offset: offset,
          },
          data: Bookmarks,
        }
      })
      .catch(function(err) {
        debug('err', err)
        throw err
      })
  }

  // Bookmark count
  BookmarkSchema.statics.countByPageId = async function(pageId) {
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
  BookmarkSchema.statics.findByUser = function(user, option) {
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
        .exec(function(err, Bookmarks) {
          if (err) {
            return reject(err)
          }

          if (!populatePage) {
            return resolve(Bookmarks)
          }

          return Bookmark.populatePage(Bookmarks, requestUser).then(resolve)
        })
    })
  }

  BookmarkSchema.statics.add = async function(page, user) {
    const Bookmark = this

    const newBookmark = new (Bookmark as any)({ page, user, createdAt: Date.now() })

    try {
      const Bookmark = await newBookmark.save()
      BookmarkEvent.emit('create', page._id)
      return Bookmark
    } catch (err) {
      if (err.code === 11000) {
        // duplicate key (dummy response of new object)
        return newBookmark
      }
      debug('Bookmark.save failed', err)
      throw err
    }
  }

  BookmarkSchema.statics.removeBookmarksByPageId = async function(pageId) {
    const Bookmark = this

    try {
      const data = await Bookmark.remove({ page: pageId })
      BookmarkEvent.emit('delete', pageId)
      return data
    } catch (err) {
      debug('Bookmark.remove failed (removeBookmarkByPage)', err)
      throw err
    }
  }

  BookmarkSchema.statics.removeBookmark = async function(page, user) {
    const Bookmark = this

    try {
      const data = await Bookmark.findOneAndRemove({ page, user })
      BookmarkEvent.emit('delete', page)
      return data
    } catch (err) {
      debug('Bookmark.findOneAndRemove failed', err)
      throw err
    }
  }

  return mongoose.model<BookmarkDocument>('Bookmark', BookmarkSchema)
}
