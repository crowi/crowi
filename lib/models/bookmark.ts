import Crowi from 'server/crowi'
import { Types, Document, Model, Schema, model } from 'mongoose'
import Debug from 'debug'

export interface BookmarkDocument extends Document {
  _id: Types.ObjectId
  page: Types.ObjectId | any
  user: Types.ObjectId | any
  createdAt: Date
}
export interface BookmarkModel extends Model<BookmarkDocument> {
  populatePage(bookmarks: any[], requestUser?: any): Promise<BookmarkDocument[]>
  findByPageIdAndUserId(pageId: Types.ObjectId, userId: Types.ObjectId): Promise<BookmarkDocument | null>
  findByUserId(
    userId: Types.ObjectId,
    option: any,
  ): Promise<{
    meta: {
      total: any
      limit: any
      offset: any
    }
    data: any
  }>
  countByPageId(pageId: Types.ObjectId): Promise<number>
  findByUser(user: any, option: any): Promise<BookmarkDocument[]>
  add(page: any, user: any): Promise<BookmarkDocument>
  removeBookmarksByPageId(pageId: Types.ObjectId): any
  removeBookmark(page: any, user: any): any
}

export default (crowi: Crowi) => {
  const debug = Debug('crowi:models:Bookmark')
  const BookmarkEvent = crowi.event('Bookmark')

  const BookmarkSchema = new Schema<BookmarkDocument, BookmarkModel>({
    page: { type: Schema.Types.ObjectId, ref: 'Page', index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    createdAt: { type: Date, default: Date.now() },
  })
  BookmarkSchema.index({ page: 1, user: 1 }, { unique: true })

  BookmarkSchema.statics.populatePage = async function (bookmarks, requestUser) {
    requestUser = requestUser || null

    const populatedBookmarks = await Bookmark.populate(bookmarks, {
      path: 'page',
      populate: { path: 'revision', model: 'Revision', populate: { path: 'author', model: 'User' } },
    })

    // hmm...
    return populatedBookmarks.filter((bookmark) => {
      // requestUser を指定しない場合 public のみを返す
      if (requestUser === null) {
        return bookmark.page.isPublic()
      }

      return bookmark.page.isGrantedFor(requestUser)
    })
  }

  // Bookmark チェック用
  BookmarkSchema.statics.findByPageIdAndUserId = function (pageId, userId) {
    return Bookmark.findOne({ page: pageId, user: userId }).exec()
  }

  BookmarkSchema.statics.findByUserId = async function (userId, option) {
    const limit = option.limit || 50
    const offset = option.offset || 0

    const finder = Bookmark.find({ user: userId })
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .exec()
      .then((bookmarks) => Bookmark.populatePage(bookmarks))

    const counter = Bookmark.countDocuments({ user: userId }).exec()

    const [bookmarks, count] = await Promise.all([finder, counter])

    return {
      meta: {
        total: count,
        limit: limit,
        offset: offset,
      },
      data: bookmarks,
    }
  }

  // Bookmark count
  BookmarkSchema.statics.countByPageId = async function (pageId) {
    const count = await Bookmark.countDocuments({ page: pageId })

    return count
  }

  BookmarkSchema.statics.findByUser = async function (user, option) {
    const requestUser = option.requestUser || null

    const limit = option.limit || 50
    const offset = option.offset || 0
    const populatePage = option.populatePage || false

    const bookmarks = await Bookmark.find({ user: user._id }).sort({ createdAt: -1 }).skip(offset).limit(limit).exec()

    if (!populatePage) {
      return bookmarks
    }

    return Bookmark.populatePage(bookmarks, requestUser)
  }

  BookmarkSchema.statics.add = async function (page, user) {
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

  BookmarkSchema.statics.removeBookmarksByPageId = async function (pageId) {
    try {
      const data = await Bookmark.deleteMany({ page: pageId })
      BookmarkEvent.emit('delete', pageId)
      return data
    } catch (err) {
      debug('Bookmark.remove failed (removeBookmarkByPage)', err)
      throw err
    }
  }

  BookmarkSchema.statics.removeBookmark = async function (page, user) {
    try {
      const data = await Bookmark.findOneAndRemove({ page, user })
      BookmarkEvent.emit('delete', page)
      return data
    } catch (err) {
      debug('Bookmark.findOneAndRemove failed', err)
      throw err
    }
  }

  const Bookmark = model<BookmarkDocument, BookmarkModel>('Bookmark', BookmarkSchema)

  return Bookmark
}
