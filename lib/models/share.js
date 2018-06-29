module.exports = function(crowi) {
  const debug = require('debug')('crowi:models:page')
  const mongoose = require('mongoose')
  const uuidv4 = require('uuid/v4')
  const mongoosePaginate = require('mongoose-paginate')
  const ObjectId = mongoose.Schema.Types.ObjectId
  const STATUS_ACTIVE = 'active'
  const STATUS_INACTIVE = 'inactive'

  const shareSchema = new mongoose.Schema(
    {
      id: { type: String, required: true, index: true, unique: true },
      page: { type: ObjectId, ref: 'Page', required: true, index: true },
      status: { type: String, default: STATUS_ACTIVE, index: true },
      creator: { type: ObjectId, ref: 'User', required: true, index: true },
      secretKeyword: String,
      accesses: [{ type: ObjectId, ref: 'Access' }],
      extended: {
        type: String,
        default: '{}',
        get: data => {
          try {
            return JSON.parse(data)
          } catch (e) {
            return data
          }
        },
        set: data => {
          return JSON.stringify(data)
        },
      },
      createdAt: { type: Date, default: Date.now },
      updatedAt: Date,
    },
    {
      toJSON: { getters: true },
      toObject: { getters: true },
    },
  )
  shareSchema.plugin(mongoosePaginate)

  shareSchema.methods.isActive = function() {
    return this.status === STATUS_ACTIVE
  }

  shareSchema.methods.isInactive = function() {
    return this.status === STATUS_INACTIVE
  }

  shareSchema.methods.isCreator = function(userData) {
    this.populate('creator')
    const creatorId = this.creator._id.toString()
    const userId = userData._id.toString()

    return creatorId === userId
  }

  shareSchema.methods.access = async function(shareId, trackingId) {
    const Access = crowi.model('Access')
    const access = await Access.create({ share: shareId, tracking: trackingId })
    this.accesses = this.accesses.concat([access])
    return this.save()
  }

  shareSchema.statics.isExists = async function(query) {
    const self = this
    const count = await self.count(query)
    return count > 0
  }

  shareSchema.statics.findShares = async function(query, options = {}) {
    const self = this
    const User = crowi.model('User')
    const page = options.page || 1
    const limit = options.limit || 50
    const sort = options.sort || { createdAt: -1 }

    return self.paginate(query, {
      page,
      limit,
      sort,
      populate: [
        {
          path: 'accesses',
          populate: { path: 'tracking' },
        },
        {
          path: 'page',
        },
        {
          path: 'creator',
          select: User.USER_PUBLIC_FIELDS,
        },
      ],
    })
  }

  shareSchema.statics.findShare = async function(query) {
    const self = this
    const User = crowi.model('User')
    const Page = crowi.model('Page')

    const shareData = await self
      .findOne(query)
      .populate({ path: 'accesses',
      populate: { path: 'tracking' } })
      .populate({ path: 'page' })
      .populate({
        path: 'creator',
        select: User.USER_PUBLIC_FIELDS,
      })
      .exec((err, shareData) => {
        if (err) {
          throw err
        }
        return shareData
      })

    if (shareData === null) {
      const shareNotFoundError = new Error('Share Not Found')
      shareNotFoundError.name = 'Crowi:Share:NotFound'
      throw shareNotFoundError
    }

    shareData.page = await Page.populatePageData(shareData.page)
    return shareData
  }

  shareSchema.statics.findShareById = async function(id, query) {
    const self = this
    query = Object.assign({ id }, query !== undefined ? query : {})
    return self.findShare(query)
  }

  shareSchema.statics.findShareByPageId = async function(pageId, query) {
    const self = this
    query = Object.assign({ page: pageId }, query !== undefined ? query : {})
    return self.findShare(query)
  }

  shareSchema.statics.updateProperty = async function(share, updateData) {
    const self = this
    return self.update({ _id: share._id }, { $set: updateData }, (err, data) => {
      if (err) {
        throw err
      }

      return data
    })
  }

  shareSchema.statics.create = async function(pageId, user) {
    const Share = this

    const isExists = await Share.isExists({
      page: pageId,
      status: STATUS_ACTIVE,
    })
    if (isExists) {
      throw new Error('Cannot create new share.')
    }

    const newShare = new Share({
      id: uuidv4(),
      page: pageId,
      creator: user,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: STATUS_ACTIVE,
    })
    newShare.save(err => {
      if (err) {
        throw err
      }
    })
    return newShare
  }

  shareSchema.statics.delete = async function(shareData) {
    var self = this

    const data = await self.updateProperty(shareData, {
      status: STATUS_INACTIVE,
    })
    return data
  }

  shareSchema.statics.STATUS_ACTIVE = STATUS_ACTIVE
  shareSchema.statics.STATUS_INACTIVE = STATUS_INACTIVE

  return mongoose.model('Share', shareSchema)
}
