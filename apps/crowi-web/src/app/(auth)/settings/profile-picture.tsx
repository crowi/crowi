'use client';

import { useRef, useState } from 'react';
import { Upload, Trash2, User } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useUploadPicture, useDeletePicture } from '@/lib/use-profile';
import type { UserProfileResponse } from '@crowi/api-contract';

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

    // Validate file type
    if (!file.type.startsWith('image/')) {
      setError('画像ファイルを選択してください');
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      setError('ファイルサイズは5MB以下にしてください');
      return;
    }

    setError(null);
    try {
      await uploadPicture.mutateAsync(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'アップロードに失敗しました');
    }
  };

  const handleDelete = async () => {
    if (!confirm('プロフィール画像を削除しますか？')) return;

    setError(null);
    try {
      await deletePicture.mutateAsync();
    } catch (err) {
      setError(err instanceof Error ? err.message : '削除に失敗しました');
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
              {uploadPicture.isPending ? 'アップロード中...' : '画像を選択'}
            </Button>

            {profile.image && (
              <Button type="button" variant="outline" size="sm" onClick={handleDelete} disabled={isLoading}>
                <Trash2 className="mr-2" />
                {deletePicture.isPending ? '削除中...' : '削除'}
              </Button>
            )}
          </div>

          <p className="text-xs text-muted-foreground">推奨: 正方形の画像、最大5MB、JPG・PNG・GIF形式</p>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileChange} className="hidden" aria-label="プロフィール画像を選択" />
    </div>
  );
}
