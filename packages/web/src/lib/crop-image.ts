/**
 * Client-side avatar crop + downscale helpers.
 *
 * The profile-picture flow lets the user pick a square crop region
 * (react-easy-crop gives us `croppedAreaPixels`), then we draw just that
 * region onto an offscreen canvas sized to `OUTPUT_SIZE` and re-encode it.
 * The result is a small, square, normalised image — so a 10MB phone photo
 * never reaches the API; only a ~tens-of-KB avatar does.
 */

/** Output edge length in px. Avatars never render larger than this. */
export const OUTPUT_SIZE = 256;

/** Pixel-space crop rect from react-easy-crop's `onCropComplete`. */
export interface CropAreaPixels {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Load an object-URL / data-URL into an HTMLImageElement. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(image));
    image.addEventListener('error', (err) => reject(err));
    // Same-origin object URLs don't need crossOrigin, but setting it is
    // harmless and keeps the canvas untainted if the src ever changes.
    image.crossOrigin = 'anonymous';
    image.src = src;
  });
}

/**
 * Crop `imageSrc` to `area` and downscale to OUTPUT_SIZE × OUTPUT_SIZE,
 * returning a `File` ready for the existing multipart upload.
 *
 * Encodes to WebP when the browser supports it (smaller), else PNG. The
 * file name extension matches the chosen type because the API infers the
 * stored extension from the upload's name (`createUserPictureFilePath`).
 */
export async function cropImageToFile(imageSrc: string, area: CropAreaPixels): Promise<File> {
  const image = await loadImage(imageSrc);

  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas 2d context');

  // High-quality downscale.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Draw the selected source rect into the full output square.
  ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

  const { blob, ext } = await canvasToBlob(canvas);
  return new File([blob], `avatar.${ext}`, { type: blob.type });
}

/** Prefer WebP; fall back to PNG when toBlob yields nothing for WebP. */
function canvasToBlob(canvas: HTMLCanvasElement): Promise<{ blob: Blob; ext: string }> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (webp) => {
        if (webp) {
          resolve({ blob: webp, ext: 'webp' });
          return;
        }
        canvas.toBlob((png) => {
          if (png) resolve({ blob: png, ext: 'png' });
          else reject(new Error('Canvas toBlob returned null'));
        }, 'image/png');
      },
      'image/webp',
      0.9,
    );
  });
}
