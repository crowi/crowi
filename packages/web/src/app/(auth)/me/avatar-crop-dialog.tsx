'use client';

import { m } from '@paraglide/messages.js';
import { ZoomIn } from 'lucide-react';
import { useCallback, useState } from 'react';
import Cropper from 'react-easy-crop';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Slider } from '@/components/ui/slider';
import { type CropAreaPixels, cropImageToFile } from '@/lib/crop-image';

interface AvatarCropDialogProps {
  /** Object URL of the source image the user picked. */
  imageSrc: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the cropped + downscaled file when the user confirms. */
  onCropped: (file: File) => void;
  /** `true` while the parent's upload mutation is in flight. */
  isUploading?: boolean;
}

/**
 * Square-crop + zoom dialog for the profile picture. The user frames the
 * image (react-easy-crop), and on confirm we render just the selected
 * region to a small canvas (`cropImageToFile`) so only a normalised,
 * downscaled avatar is uploaded — never the original full-size photo.
 */
export function AvatarCropDialog({ imageSrc, open, onOpenChange, onCropped, isUploading = false }: AvatarCropDialogProps) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<CropAreaPixels | null>(null);
  const [processing, setProcessing] = useState(false);

  const onCropComplete = useCallback((_area: unknown, areaPixels: CropAreaPixels) => {
    setCroppedAreaPixels(areaPixels);
  }, []);

  const handleConfirm = async () => {
    if (!croppedAreaPixels) return;
    setProcessing(true);
    try {
      const file = await cropImageToFile(imageSrc, croppedAreaPixels);
      onCropped(file);
    } finally {
      setProcessing(false);
    }
  };

  const busy = processing || isUploading;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{m['me.profile_picture.crop_title']()}</DialogTitle>
          <DialogDescription>{m['me.profile_picture.crop_description']()}</DialogDescription>
        </DialogHeader>

        <div className="relative h-64 w-full overflow-hidden rounded-md bg-muted">
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={1}
            cropShape="round"
            showGrid={false}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
          />
        </div>

        <div className="flex items-center gap-3">
          <ZoomIn className="size-4 shrink-0 text-muted-foreground" />
          <Slider value={[zoom]} min={1} max={3} step={0.01} onValueChange={(v) => setZoom(v[0] ?? 1)} aria-label={m['me.profile_picture.crop_zoom']()} />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {m['me.profile_picture.crop_cancel']()}
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={busy || !croppedAreaPixels}>
            {busy ? m['me.profile_picture.crop_saving']() : m['me.profile_picture.crop_confirm']()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
