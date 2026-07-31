/**
 * Extension → media type, used to declare what an uploaded file actually is.
 *
 * Why the CLI needs this at all: `FormData.append(name, blob, filename)` sends
 * whatever `blob.type` says, and a `Blob` built without one declares nothing —
 * which the api stores verbatim as the attachment's `fileFormat`
 * (`packages/api/src/hono/handlers/attachment.ts`, `file.type ||
 * 'application/octet-stream'`). A browser gets this for free from the file
 * picker; Node does not, so we look it up from the name.
 *
 * Deliberately NOT shared with `KEY_EXT_TO_MIME` in the api's
 * `attachment-stream.ts`. That map answers a different question — which stored
 * types may be served *inline* — and is kept narrow on purpose as part of the
 * attachment XSS boundary. This map answers "what is this file", and wants to
 * grow. Merging them would let a addition here widen inline delivery there.
 *
 * An unknown extension yields `application/octet-stream`, which is both the
 * multipart default and the safe answer: delivery serves any non-allow-listed
 * type as a download regardless.
 */
const EXT_TO_MEDIA_TYPE: Record<string, string> = {
  // Raster images — the types attachment delivery will serve inline.
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  apng: 'image/apng',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  // Documents / text.
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  // Office.
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Archives.
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  // Audio / video.
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

export const DEFAULT_MEDIA_TYPE = 'application/octet-stream';

/**
 * The media type to declare for `filename`, by extension. Returns
 * `application/octet-stream` when the extension is unknown or absent.
 */
export function mediaTypeForFilename(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 1 || dot === filename.length - 1) return DEFAULT_MEDIA_TYPE;
  const ext = filename.slice(dot + 1).toLowerCase();
  // `Object.hasOwn`, not a plain lookup: the map inherits from
  // `Object.prototype`, so `foo.constructor` / `foo.toString` would otherwise
  // resolve to a function and be declared as the media type.
  return Object.hasOwn(EXT_TO_MEDIA_TYPE, ext) ? EXT_TO_MEDIA_TYPE[ext] : DEFAULT_MEDIA_TYPE;
}
