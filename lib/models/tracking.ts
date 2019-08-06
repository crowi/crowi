import Crowi from 'server/crowi'
import { Types, Document, Schema, model } from 'mongoose'

export interface TrackingDocument extends Document {
  _id: Types.ObjectId
  userAgent: string
  remoteAddress: string
  createdAt: Date
}

export default (crowi: Crowi) => {
  // const debug = Debug('crowi:models:tracking')

  const trackingSchema = new Schema<TrackingDocument>({
    userAgent: { type: String, required: true },
    remoteAddress: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  })

  const Tracking = model<TrackingDocument>('Tracking', trackingSchema)

  return Tracking
}
