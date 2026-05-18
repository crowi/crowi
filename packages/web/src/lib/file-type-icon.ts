import { File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, type LucideIcon } from 'lucide-react';

/**
 * Resolve a file to a `lucide-react` icon for the attachment list.
 *
 * Resolution order: (1) MIME type (exact match, then `type/` prefix),
 * (2) the file name's extension, (3) a generic `File` fallback. The MIME
 * type is the primary key because the API always sends `fileFormat`; the
 * extension is a secondary key for the rare case of an empty / unknown
 * MIME. lucide has no dedicated PDF icon, so PDFs map to `FileText`.
 *
 * Image files are normally shown as a thumbnail by `AttachmentList`, so
 * `FileImage` here is only a fallback (e.g. an `image/*` entry that fails
 * to load, or a non-rendering image type).
 */
const MIME_EXACT: Record<string, LucideIcon> = {
  'application/pdf': FileText,
  'application/zip': FileArchive,
  'application/x-zip-compressed': FileArchive,
  'application/x-tar': FileArchive,
  'application/gzip': FileArchive,
  'application/x-7z-compressed': FileArchive,
  'application/x-rar-compressed': FileArchive,
  'application/json': FileCode,
  'application/xml': FileCode,
  'text/csv': FileSpreadsheet,
  'text/markdown': FileText,
  'text/plain': FileText,
  'text/html': FileCode,
  'text/xml': FileCode,
  'application/vnd.ms-excel': FileSpreadsheet,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': FileSpreadsheet,
};

const MIME_PREFIX: Array<[string, LucideIcon]> = [
  ['image/', FileImage],
  ['audio/', FileAudio],
  ['video/', FileVideo],
  ['text/', FileText],
];

const EXTENSION: Record<string, LucideIcon> = {
  pdf: FileText,
  zip: FileArchive,
  tar: FileArchive,
  gz: FileArchive,
  tgz: FileArchive,
  '7z': FileArchive,
  rar: FileArchive,
  csv: FileSpreadsheet,
  xls: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  json: FileCode,
  xml: FileCode,
  html: FileCode,
  htm: FileCode,
  js: FileCode,
  ts: FileCode,
  css: FileCode,
  md: FileText,
  markdown: FileText,
  txt: FileText,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  svg: FileImage,
  mp3: FileAudio,
  wav: FileAudio,
  ogg: FileAudio,
  mp4: FileVideo,
  mov: FileVideo,
  webm: FileVideo,
};

/**
 * Pick a file-type icon from a MIME type, falling back to the file name's
 * extension and finally a generic `File` icon.
 */
export function getFileTypeIcon(mime: string, fileName?: string): LucideIcon {
  const normalizedMime = mime.trim().toLowerCase();
  if (normalizedMime) {
    const exact = MIME_EXACT[normalizedMime];
    if (exact) return exact;
    const prefixed = MIME_PREFIX.find(([prefix]) => normalizedMime.startsWith(prefix));
    if (prefixed) return prefixed[1];
  }

  if (fileName) {
    const dot = fileName.lastIndexOf('.');
    if (dot >= 0 && dot < fileName.length - 1) {
      const ext = fileName.slice(dot + 1).toLowerCase();
      const byExt = EXTENSION[ext];
      if (byExt) return byExt;
    }
  }

  return File;
}
