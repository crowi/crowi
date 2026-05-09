'use client';

import { useRef, useState } from 'react';
import { Upload, Trash2, User } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useUploadPicture, useDeletePicture } from '@/lib/use-profile';
import type { UserProfileResponse } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

interface ProfilePictureProps {
  profile: UserProfileResponse;
}

export function ProfilePicture({ profile }: ProfilePictureProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const uploadPicture = useUploadPicture();
  const deletePicture = useDeletePicture();

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
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
    try {
      await uploadPicture.mutateAsync(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : m['me.profile_picture.error_upload']());
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
          {profile.image && <AvatarImage src={profile.image} alt={profile.name} />}
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
    </div>
  );
}
