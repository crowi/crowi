import Crowi from 'server/crowi'
import { Types, Document, Model, Schema, model } from 'mongoose'
import Debug from 'debug'
import crypto from 'crypto'
import FileUploader from '../utils/fileUploader'

export interface AttachmentDocument extends Document {
  _id: Types.ObjectId
  page: Types.ObjectId
  creator: Types.ObjectId
  filePath: string
  fileName: string
  originalName: string
  fileFormat: string
  fileSize: number
  createdAt: Date

  // virtual
  fileUrl: string

  // dynamic field
  url: string
}

export interface AttachmentModel extends Model<AttachmentDocument> {
  getListByPageId(id: Types.ObjectId): Promise<AttachmentDocument[]>
  guessExtByFileType(fileType: string): string
  createAttachmentFilePath(pageId: Types.ObjectId, fileName: string, fileType: string): string
  removeAttachmentsByPageId(pageId: Types.ObjectId): any
  findDeliveryFile(attachment: AttachmentDocument, forceUpdate?: boolean): any
  removeAttachment(attachment: AttachmentDocument): any
}

export default (crowi: Crowi) => {
  const debug = Debug('crowi:models:attachment')
  const fileUploader = FileUploader(crowi)

  function generateFileHash(fileName) {
    const hasher = crypto.createHash('md5')
    hasher.update(fileName)

    return hasher.digest('hex')
  }

  const attachmentSchema = new Schema<AttachmentDocument, AttachmentModel>(
    {
      page: { type: Schema.Types.ObjectId, ref: 'Page', index: true },
      creator: { type: Schema.Types.ObjectId, ref: 'User', index: true },
      filePath: { type: String, required: true },
      fileName: { type: String, required: true },
      originalName: { type: String },
      fileFormat: { type: String, required: true },
      fileSize: { type: Number, default: 0 },
      createdAt: { type: Date, default: Date.now },
    },
    {
      toJSON: {
        virtuals: true,
      },
    },
  )

  attachmentSchema.virtual('fileUrl').get(function(this: AttachmentDocument) {
    return `/files/${this._id}`
  })

  attachmentSchema.statics.getListByPageId = function(id) {
    return Attachment.find({ page: id })
      .sort({ updatedAt: 1 })
      .populate('creator')
      .exec()
  }

  attachmentSchema.statics.guessExtByFileType = function(fileType) {
    let ext = ''
    const isImage = fileType.match(/^image\/(.+)/i)

    if (isImage) {
      ext = isImage[1].toLowerCase()
    }

    return ext
  }

  attachmentSchema.statics.createAttachmentFilePath = function(pageId, fileName, fileType) {
    let ext = ''
    const fnExt = fileName.match(/(.*)(?:\.([^.]+$))/)

    if (fnExt) {
      ext = '.' + fnExt[2]
    } else {
      ext = Attachment.guessExtByFileType(fileType)
      if (ext !== '') {
        ext = '.' + ext
      }
    }

    return 'attachment/' + pageId + '/' + generateFileHash(fileName) + ext
  }

  attachmentSchema.statics.removeAttachmentsByPageId = async function(pageId) {
    const attachments = await Attachment.getListByPageId(pageId)
    await Promise.all(attachments.map(attachment => Attachment.removeAttachment(attachment)))

    return attachments
  }

  attachmentSchema.statics.findDeliveryFile = function(attachment, forceUpdate) {
    // TODO
    forceUpdate = forceUpdate || false

    return fileUploader.findDeliveryFile(attachment._id, attachment.filePath)
  }

  attachmentSchema.statics.removeAttachment = async function(attachment) {
    const filePath = attachment.filePath

    await Attachment.deleteOne({ _id: attachment._id })

    const data = await fileUploader.deleteFile(attachment._id, filePath)

    return data
  }

  const Attachment = model<AttachmentDocument, AttachmentModel>('Attachment', attachmentSchema)

  return Attachment
}
