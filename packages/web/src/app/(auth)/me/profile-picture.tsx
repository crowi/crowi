'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import { Upload, Trash2, User } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { canonicalizeLegacyAttachmentUrl } from '@/lib/attachment-url';
import { useUploadPicture, useDeletePicture } from '@/lib/use-profile';
import type { UserProfileResponse } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

// react-easy-crop is only needed once the user opens the crop dialog, so
// keep it (and its ~tens-of-KB) out of the profile page's initial bundle.
const AvatarCropDialog = dynamic(() => import('./avatar-crop-dialog').then((mod) => mod.AvatarCropDialog), { ssr: false });

interface ProfilePictureProps {
  profile: UserProfileResponse;
}

export function ProfilePicture({ profile }: ProfilePictureProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Object URL of the picked source image while the crop dialog is open.
  // Revoked on close so we don't leak the blob.
  const [cropSrc, setCropSrc] = useState<string | null>(null);

  const uploadPicture = useUploadPicture();
  const deletePicture = useDeletePicture();

  // Revoke the previous object URL whenever cropSrc changes (new pick, close,
  // or unmount) so the blob is freed exactly once. This is the single owner
  // of revocation — callers just setCropSrc(null) to close.
  useEffect(() => {
    if (!cropSrc) return;
    return () => URL.revokeObjectURL(cropSrc);
  }, [cropSrc]);

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  // Pick → validate → open the crop dialog with an object URL of the
  // source. The actual upload happens in `handleCropped` with the
  // cropped + downscaled file, so a huge original never reaches the API.
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file again re-triggers change.
    e.target.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setError(m['me.profile_picture.error_not_image']());
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setError(m['me.profile_picture.error_too_large']());
      return;
    }

    setError(null);
    setCropSrc(URL.createObjectURL(file));
  };

  // Closing just clears cropSrc; the useEffect above revokes the object URL.
  const closeCrop = () => setCropSrc(null);

  const handleCropped = async (file: File) => {
    try {
      await uploadPicture.mutateAsync(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : m['me.profile_picture.error_upload']());
    } finally {
      closeCrop();
    }
  };

  const handleDelete = async () => {
    if (!confirm(m['me.profile_picture.delete_confirm']())) return;

    setError(null);
    try {
      await deletePicture.mutateAsync();
    } catch (err) {
      setError(err instanceof Error ? err.message : m['me.profile_picture.error_delete']());
    }
  };

  const isLoading = uploadPicture.isPending || deletePicture.isPending;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <Avatar className="size-24">
          {profile.image && <AvatarImage src={canonicalizeLegacyAttachmentUrl(profile.image)} alt={profile.name} />}
          <AvatarFallback>
            <User className="size-12 text-muted-foreground" />
          </AvatarFallback>
        </Avatar>

        <div className="flex-1 space-y-2">
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={handleUploadClick} disabled={isLoading}>
              <Upload className="mr-2" />
              {uploadPicture.isPending ? m['me.profile_picture.upload_pending']() : m['me.profile_picture.upload']()}
            </Button>

            {profile.image && (
              <Button type="button" variant="outline" size="sm" onClick={handleDelete} disabled={isLoading}>
                <Trash2 className="mr-2" />
                {deletePicture.isPending ? m['me.profile_picture.delete_pending']() : m['me.profile_picture.delete']()}
              </Button>
            )}
          </div>

          <p className="text-xs text-muted-foreground">{m['me.profile_picture.recommendation']()}</p>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        className="hidden"
        aria-label={m['me.profile_picture.aria_select']()}
      />

      {cropSrc && (
        <AvatarCropDialog
          imageSrc={cropSrc}
          open={cropSrc !== null}
          onOpenChange={(next) => {
            if (!next) closeCrop();
          }}
          onCropped={handleCropped}
          isUploading={uploadPicture.isPending}
        />
      )}
    </div>
  );
}
