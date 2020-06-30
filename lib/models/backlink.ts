import Crowi from 'server/crowi'
import { Types, Document, Model, Schema, model } from 'mongoose'
import Debug from 'debug'
import LinkDetector from 'server/util/linkDetector'
import { PageDocument } from './page'

export interface BacklinkDocument extends Document {
  _id: Types.ObjectId
  page: Types.ObjectId | any
  fromPage: Types.ObjectId | any
  fromRevision: Types.ObjectId | any
  updatedAt: Date
}

export interface BacklinkModel extends Model<BacklinkDocument> {
  findByPageId(pageId: Types.ObjectId, limit: any, offset: any): Promise<BacklinkDocument[]>
  removeByPageId(pageId: Types.ObjectId): any
  removeBySavedPage(savedPage: any)
  createByParameters(parameters: any): Promise<BacklinkDocument>
  createBySavedPage(savedPage: any): Promise<BacklinkDocument[]>
  createByAllPages(): Promise<BacklinkDocument[][]>
}

export default (crowi: Crowi) => {
  const debug = Debug('crowi:models:backlink')
  const linkDetector = LinkDetector(crowi)

  const backlinkSchema = new Schema<BacklinkDocument, BacklinkModel>({
    page: { type: Schema.Types.ObjectId, ref: 'Page', index: true },
    fromPage: { type: Schema.Types.ObjectId, ref: 'Page' },
    fromRevision: { type: Schema.Types.ObjectId, ref: 'Revision' },
    updatedAt: { type: Date, default: Date.now, index: true },
  })

  backlinkSchema.statics.findByPageId = async function (pageId, limit, offset) {
    limit = limit || 10
    offset = offset || 0

    limit = parseInt(limit, 10)
    offset = parseInt(offset, 10)

    const conditions = { page: pageId }
    const projection = { fromPage: 1, fromRevision: 1, updatedAt: 1 }
    const options = { limit, skip: offset, sort: { updatedAt: -1 } }

    const backlinks = await Backlink.find(conditions, projection, options).populate('fromPage').populate('fromRevision')

    // populate author
    const populateOptions = {
      path: 'fromRevision.author',
      model: 'User',
      select: {
        username: 1,
        name: 1,
        image: 1,
      },
    }

    const populatedBacklinks = await Backlink.populate(backlinks, populateOptions)

    return populatedBacklinks
  }

  backlinkSchema.statics.removeByPageId = function (pageId) {
    // FIXME: removeByPageId is a bit confusable name. Should it removeByFromPageId ?
    return Backlink.deleteMany({ fromPage: pageId })
  }

  backlinkSchema.statics.removeBySavedPage = async function (savedPage) {
    const conditions = {
      fromPage: savedPage._id,
    }

    await Backlink.deleteMany(conditions)
  }

  backlinkSchema.statics.createByParameters = async function (parameters) {
    const data = {
      page: parameters.page,
      fromPage: parameters.fromPage,
      fromRevision: parameters.fromRevision,
      updatedAt: Date.now(),
    }
    return Backlink.create(data)
  }

  const convertLinksToPageIds = async (page, { paths, objectIds }) => {
    const Page = crowi.model('Page')

    let ids = await Promise.all([...paths.map((path) => Page.isExistByPath(path)), ...objectIds.map((id) => Page.isExistById(id))])

    // Make unique and remove own page
    ids = ids.filter((id, index, array) => array.indexOf(id) === index && id.toString() !== page._id.toString() && id !== false)

    return ids
  }

  backlinkSchema.statics.createBySavedPage = async function (savedPage) {
    if (!(savedPage.revision && savedPage.revision.body)) {
      throw new Error('no revision/body in savedPage')
    }

    const body = savedPage.revision.body

    await Backlink.removeBySavedPage(savedPage)

    const links = linkDetector.search(body)
    const ids = await convertLinksToPageIds(savedPage, links)

    const backlinks = await Promise.all(
      ids.map((id) =>
        Backlink.createByParameters({
          page: id,
          fromPage: savedPage._id,
          fromRevision: savedPage.revision._id,
        }),
      ),
    )

    debug('All backlinks saved')
    return backlinks
  }

  backlinkSchema.statics.createByAllPages = async function () {
    const Page = crowi.model('Page')
    const Revision = crowi.model('Revision')

    const pages = await Page.find({}).select('_id revision')
    const latestRevisionIds = pages.map(({ revision }) => revision)

    const revisions = await Revision.find({ _id: { $in: latestRevisionIds } }).and({
      $or: [{ body: linkDetector.getLinkRegexp() }, { body: linkDetector.getPathRegexps()[0] }, { body: linkDetector.getPathRegexps()[1] }],
    } as any)

    await Backlink.deleteMany({})

    return Promise.all(
      revisions.map(async ({ _id: revisionId, body }) => {
        const page = pages.find(({ revision }) => revision.toString() === revisionId.toString()) as PageDocument
        const pageId = page._id

        const links = linkDetector.search(body)
        const ids = await convertLinksToPageIds(page, links)

        const backlinks = await Promise.all(
          ids.map((id) =>
            Backlink.createByParameters({
              page: id,
              fromPage: pageId,
              fromRevision: revisionId,
            }),
          ),
        )

        debug('All backlinks saved')
        return backlinks
      }),
    )
  }

  const Backlink = model<BacklinkDocument, BacklinkModel>('BackLink', backlinkSchema)

  return Backlink
}
