module.exports = function(crowi) {
  const debug = require('debug')('crowi:models:backlink')
  const mongoose = require('mongoose')
  const ObjectId = mongoose.Schema.Types.ObjectId
  const linkDetector = require('../util/linkDetector')(crowi)

  var backlinkSchema

  backlinkSchema = new mongoose.Schema({
    page: { type: ObjectId, ref: 'Page', index: true },
    fromPage: { type: ObjectId, ref: 'Page' },
    fromRevision: { type: ObjectId, ref: 'Revision' },
    updatedAt: { type: Date, default: Date.now, index: true },
  })

  backlinkSchema.statics.findByPageId = function(pageId, limit, offset) {
    var Backlink = this
    limit = limit || 10
    offset = offset || 0

    limit = parseInt(limit, 10)
    offset = parseInt(offset, 10)

    return new Promise((resolve, reject) => {
      var conditions = {
        page: pageId,
      }
      var projection = {
        fromPage: 1,
        fromRevision: 1,
        updatedAt: 1,
      }
      var options = {
        limit: limit,
        skip: offset,
        sort: { updatedAt: -1 },
      }

      Backlink.find(conditions, projection, options)
        .populate('fromPage')
        .populate('fromRevision')
        .exec((err, backlinks) => {
          if (err) {
            return reject(err)
          }

          // populate author
          var options = {
            path: 'fromRevision.author',
            model: 'User',
            select: {
              username: 1,
              name: 1,
              image: 1,
            },
          }
          Backlink.populate(backlinks, options, (err, backlinks) => {
            if (err) {
              return reject(err)
            }

            return resolve(backlinks)
          })
        })
    })
  }

  backlinkSchema.statics.removeByPageId = function(pageId) {
    const Backlink = this
    return Backlink.remove({ fromPage: pageId })
  }

  backlinkSchema.statics.removeBySavedPage = function(savedPage) {
    var Backlink = this

    return new Promise((resolve, reject) => {
      var conditions = {
        fromPage: savedPage._id,
      }

      Backlink.remove(conditions, (err, data) => {
        if (err) {
          return reject(err)
        }
        return resolve(data)
      })
    })
  }

  backlinkSchema.statics.createByParameters = function(parameters) {
    var BackLink = this

    return new Promise((resolve, reject) => {
      var data = {
        page: parameters.page,
        fromPage: parameters.fromPage,
        fromRevision: parameters.fromRevision,
        updatedAt: Date.now(),
      }
      BackLink.create(data, (err, savedBacklink) => {
        if (err) {
          return reject(err)
        }

        return resolve(savedBacklink)
      })
    })
  }

  const convertLinksToPageIds = async (page, { paths, objectIds }) => {
    const Page = crowi.model('Page')

    let ids = await Promise.all([
      ...paths.map(path => Page.isExistByPath(path)),
      ...objectIds.map(id => Page.isExistById(id)),
    ])

    // Make unique and remove own page
    ids = ids.filter(
      (id, index, array) => array.indexOf(id) === index && id.toString() !== page._id.toString() && id !== false,
    )

    return ids
  }

  backlinkSchema.statics.createBySavedPage = async function(savedPage) {
    const BackLink = this

    if (!(savedPage.revision && savedPage.revision.body)) {
      throw new Error('no revision/body in savedPage')
    }

    const body = savedPage.revision.body

    await BackLink.removeBySavedPage(savedPage)

    const links = linkDetector.search(body)
    const ids = await convertLinksToPageIds(savedPage, links)
    return Promise.all(
      ids.map(id =>
        BackLink.createByParameters({
          page: id,
          fromPage: savedPage._id,
          fromRevision: savedPage.revision._id,
        }),
      ),
    )
      .then(backlinks => {
        debug('All backlinks saved')
        return backlinks
      })
      .catch(err => {
        throw err
      })
  }

  backlinkSchema.statics.createByAllPages = async function() {
    const BackLink = this
    const Page = crowi.model('Page')
    const Revision = crowi.model('Revision')

    const pages = await Page.find({}).select('_id revision')
    const latestRevisionIds = pages.map(({ revision }) => revision)

    const revisions = await Revision.find({ _id: { $in: latestRevisionIds } }).and({
      $or: [
        { body: linkDetector.getLinkRegexp() },
        { body: linkDetector.getPathRegexps()[0] },
        { body: linkDetector.getPathRegexps()[1] },
      ],
    })

    await BackLink.remove({})

    return Promise.all(
      revisions.map(async ({ _id: revisionId, body }) => {
        const page = pages.find(({ revision }) => revision.toString() === revisionId.toString())
        const pageId = page._id

        const links = linkDetector.search(body)
        const ids = await convertLinksToPageIds(page, links)
        return Promise.all(
          ids.map(id =>
            BackLink.createByParameters({
              page: id,
              fromPage: pageId,
              fromRevision: revisionId,
            }),
          ),
        )
          .then(backlinks => {
            debug('All backlinks saved')
            return backlinks
          })
          .catch(err => {
            throw err
          })
      }),
    )
  }

  return mongoose.model('BackLink', backlinkSchema)
}
