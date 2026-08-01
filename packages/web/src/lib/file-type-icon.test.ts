import { describe, it, expect } from 'vitest';
import { File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Presentation } from 'lucide-react';
import { getFileTypeIcon } from './file-type-icon';

describe('getFileTypeIcon', () => {
  it('maps known MIME types to a matching icon', () => {
    // lucide has no dedicated PDF icon → FileText.
    expect(getFileTypeIcon('application/pdf')).toBe(FileText);
    expect(getFileTypeIcon('application/zip')).toBe(FileArchive);
    expect(getFileTypeIcon('text/csv')).toBe(FileSpreadsheet);
    expect(getFileTypeIcon('application/json')).toBe(FileCode);
    expect(getFileTypeIcon('text/markdown')).toBe(FileText);
  });

  it('maps MIME prefixes to a category icon', () => {
    expect(getFileTypeIcon('image/png')).toBe(FileImage);
    expect(getFileTypeIcon('audio/mpeg')).toBe(FileAudio);
    expect(getFileTypeIcon('video/mp4')).toBe(FileVideo);
    expect(getFileTypeIcon('text/anything')).toBe(FileText);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(getFileTypeIcon('  Application/PDF ')).toBe(FileText);
  });

  it('feature-attachment-upload-policy: maps office document types to a matching icon', () => {
    expect(getFileTypeIcon('application/msword')).toBe(FileText);
    expect(getFileTypeIcon('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(FileText);
    expect(getFileTypeIcon('application/vnd.ms-powerpoint')).toBe(Presentation);
    expect(getFileTypeIcon('application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe(Presentation);
    // Extension fallback for an empty / unknown MIME.
    expect(getFileTypeIcon('', 'report.docx')).toBe(FileText);
    expect(getFileTypeIcon('', 'slides.pptx')).toBe(Presentation);
  });

  it('falls back to the file extension when the MIME is empty / unknown', () => {
    expect(getFileTypeIcon('', 'report.csv')).toBe(FileSpreadsheet);
    expect(getFileTypeIcon('application/octet-stream', 'archive.tar')).toBe(FileArchive);
    expect(getFileTypeIcon('', 'notes.MD')).toBe(FileText);
    expect(getFileTypeIcon('', 'photo.PNG')).toBe(FileImage);
  });

  it('returns the generic File icon for an unknown MIME with no usable extension', () => {
    expect(getFileTypeIcon('application/octet-stream')).toBe(File);
    expect(getFileTypeIcon('', 'noextension')).toBe(File);
    expect(getFileTypeIcon('', 'trailingdot.')).toBe(File);
    expect(getFileTypeIcon('application/x-unknown', 'thing.unknownext')).toBe(File);
  });
});
