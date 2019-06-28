module.exports = function(crowi) {
  // const debug = require('debug')('crowi:models:share')
  const mongoose = require('mongoose')
  const uuidv4 = require('uuid/v4')
  const mongoosePaginate = require('mongoose-paginate')
  const ObjectId = mongoose.Schema.Types.ObjectId
  const STATUS_ACTIVE = 'active'
  const STATUS_INACTIVE = 'inactive'

  const shareSchema = new mongoose.Schema({
    uuid: { type: String, required: true, index: true, unique: true },
    page: { type: ObjectId, ref: 'Page', required: true, index: true },
    status: { type: String, default: STATUS_ACTIVE, index: true },
    creator: { type: ObjectId, ref: 'User', required: true, index: true },
    secretKeyword: String,
    createdAt: { type: Date, default: Date.now },
    updatedAt: Date,
  })
  shareSchema.virtual('accesses', {
    ref: 'ShareAccess',
    localField: '_id',
    foreignField: 'share',
  })
  shareSchema.set('toObject', { virtuals: true })
  shareSchema.set('toJSON', { virtuals: true })
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

  shareSchema.statics.isExists = async function(query) {
    const count = await this.count(query)
    return count > 0
  }

  shareSchema.statics.findShares = async function(query, options = {}) {
    const page = options.page || 1
    const limit = options.limit || 50
    const sort = options.sort || { createdAt: -1 }

    const { populateAccesses = false } = options
    const optionalDocs = populateAccesses
      ? [
          {
            path: 'accesses',
            populate: { path: 'tracking' },
            options: { sort: { lastAccessedAt: -1 } },
          },
        ]
      : []

    return this.paginate(query, {
      page,
      limit,
      sort,
      populate: [
        ...optionalDocs,
        {
          path: 'page',
        },
        {
          path: 'creator',
        },
      ],
    })
  }

  shareSchema.statics.findShare = async function(query, options = {}) {
    const Page = crowi.model('Page')

    const { populateAccesses = false } = options
    const optionalDocs = populateAccesses
      ? [
          {
            path: 'accesses',
            populate: { path: 'tracking' },
          },
        ]
      : []

    const shareData = await this.findOne(query)
      .populate([...optionalDocs, { path: 'page' }, { path: 'creator' }])
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

  shareSchema.statics.findShareByUuid = async function(uuid, query, options) {
    query = Object.assign({ uuid }, query !== undefined ? query : {})
    return this.findShare(query, options)
  }

  shareSchema.statics.findShareByPageId = async function(pageId, query, options) {
    query = Object.assign({ page: pageId }, query !== undefined ? query : {})

    return this.findShare(query, options)
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
      uuid: uuidv4(),
      page: pageId,
      creator: user,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: STATUS_ACTIVE,
    })
    return newShare.save()
  }

  shareSchema.statics.delete = async function(query = {}) {
    const Share = this
    const defaultQuery = { status: STATUS_ACTIVE }
    return Share.findOneAndUpdate({ ...query, ...defaultQuery }, { status: STATUS_INACTIVE }, { new: true }).exec()
  }

  shareSchema.statics.deleteById = async function(id) {
    const Share = this
    return Share.delete({ _id: id })
  }

  shareSchema.statics.deleteByPageId = async function(pageId) {
    const Share = this
    return Share.delete({ page: pageId })
  }

  shareSchema.statics.STATUS_ACTIVE = STATUS_ACTIVE
  shareSchema.statics.STATUS_INACTIVE = STATUS_INACTIVE

  return mongoose.model('Share', shareSchema)
}
