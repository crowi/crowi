import { DEFAULT_MEDIA_TYPE, mediaTypeForFilename } from './media-type';

describe('mediaTypeForFilename', () => {
  it('maps known extensions', () => {
    expect(mediaTypeForFilename('a.png')).toBe('image/png');
    expect(mediaTypeForFilename('a.jpg')).toBe('image/jpeg');
    expect(mediaTypeForFilename('a.jpeg')).toBe('image/jpeg');
    expect(mediaTypeForFilename('a.svg')).toBe('image/svg+xml');
    expect(mediaTypeForFilename('a.pdf')).toBe('application/pdf');
    expect(mediaTypeForFilename('a.md')).toBe('text/markdown');
    expect(mediaTypeForFilename('a.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('ignores extension case', () => {
    expect(mediaTypeForFilename('A.PNG')).toBe('image/png');
    expect(mediaTypeForFilename('A.JpEg')).toBe('image/jpeg');
  });

  it('uses the LAST extension', () => {
    expect(mediaTypeForFilename('archive.tar.gz')).toBe('application/gzip');
    expect(mediaTypeForFilename('report.final.pdf')).toBe('application/pdf');
  });

  it('falls back for unknown, absent, empty, and trailing-dot extensions', () => {
    expect(mediaTypeForFilename('a.qqq')).toBe(DEFAULT_MEDIA_TYPE);
    expect(mediaTypeForFilename('README')).toBe(DEFAULT_MEDIA_TYPE);
    expect(mediaTypeForFilename('')).toBe(DEFAULT_MEDIA_TYPE);
    expect(mediaTypeForFilename('trailing.')).toBe(DEFAULT_MEDIA_TYPE);
  });

  it('treats a dotfile as having no extension, not an extension of its name', () => {
    // `.gitignore` is the file's name, not a "gitignore" extension.
    expect(mediaTypeForFilename('.gitignore')).toBe(DEFAULT_MEDIA_TYPE);
    // ...but a dotfile WITH a real extension still resolves.
    expect(mediaTypeForFilename('.hidden.png')).toBe('image/png');
  });

  it('does not inherit anything from Object.prototype', () => {
    // A crafted name must not resolve via the prototype chain.
    expect(mediaTypeForFilename('a.constructor')).toBe(DEFAULT_MEDIA_TYPE);
    expect(mediaTypeForFilename('a.toString')).toBe(DEFAULT_MEDIA_TYPE);
  });
});
