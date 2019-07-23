import { Document, Schema, model } from 'mongoose'

export interface TrackingDocument extends Document {
  userAgent: string
  remoteAddress: string
  createdAt: Date
}

export default crowi => {
  // const debug = Debug('crowi:models:tracking')

  const trackingSchema = new Schema<TrackingDocument>({
    userAgent: { type: String, required: true },
    remoteAddress: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  })

  return model('Tracking', trackingSchema)
}
