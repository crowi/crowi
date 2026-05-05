'use client';

import { useState } from 'react';
import { formatDistanceToNow } from '@/lib/date-utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Breadcrumb } from '@/components/breadcrumb';
import { Clock, User, Lock, FileText, Edit2, MoveRight } from 'lucide-react';
import type { PageWithRevision } from '@crowi/api-contract';
import { PageGrantEnum } from '@crowi/api-contract';
import { BookmarkButton } from './bookmark-button';
import { DeletePageButton } from './delete-page-button';
import { RenameDialog } from './rename-dialog';

interface PageHeaderProps {
  page: PageWithRevision;
  onEdit?: () => void;
  /**
   * When true, render the Delete button next to Edit. Hidden for already-deleted
   * pages (PageView's deleted branch shows a Restore button instead).
   */
  showDelete?: boolean;
}

export function PageHeader({ page, onEdit, showDelete = false }: PageHeaderProps) {
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const creator = typeof page.creator === 'object' && page.creator ? page.creator : null;
  const lastUpdateUser = typeof page.lastUpdateUser === 'object' && page.lastUpdateUser ? page.lastUpdateUser : null;
  const author = page.revision?.author ?? null;

  // Determine which user to display
  const displayUser = lastUpdateUser ?? creator ?? author;

  // Check if page is private
  const isPrivate = page.grant === PageGrantEnum.OWNER || page.grant === PageGrantEnum.SPECIFIED;

  // Format the page title from path
  const getPageTitle = (path: string): string => {
    if (path === '/') return 'Home';
    const segments = path.split('/').filter(Boolean);
    return segments[segments.length - 1] || 'Untitled';
  };

  const pageTitle = getPageTitle(page.path);

  return (
    <div className="border-b pb-4 mb-6">
      {/* Breadcrumb */}
      <Breadcrumb path={page.path} />

      {/* Title and actions */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold truncate">{pageTitle}</h1>
            {isPrivate && <Lock className="h-5 w-5 text-muted-foreground flex-shrink-0" aria-label="Private page" />}
          </div>
          <p className="text-muted-foreground text-sm mt-1 truncate">{page.path}</p>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <BookmarkButton pageId={page._id} />
          <Button variant="outline" size="sm" onClick={() => setIsRenameOpen(true)} aria-label="Rename page">
            <MoveRight className="h-4 w-4 mr-1" />
            Rename
          </Button>
          {onEdit && (
            <Button variant="default" size="sm" onClick={onEdit}>
              <Edit2 className="h-4 w-4 mr-1" />
              Edit
            </Button>
          )}
          {showDelete && <DeletePageButton pageId={page._id} pagePath={page.path} revisionId={page.revision?._id} />}
        </div>
      </div>

      {/* Meta information */}
      <div className="flex flex-wrap items-center gap-4 mt-4 text-sm text-muted-foreground">
        {displayUser && (
          <div className="flex items-center gap-2">
            <Avatar className="h-6 w-6">
              <AvatarImage src={displayUser.image || undefined} alt={displayUser.name} />
              <AvatarFallback className="bg-primary/10 text-primary text-xs">{displayUser.name.charAt(0).toUpperCase()}</AvatarFallback>
            </Avatar>
            <span>{displayUser.name}</span>
          </div>
        )}

        {page.updatedAt && (
          <div className="flex items-center gap-1">
            <Clock className="h-4 w-4" />
            <span>Updated {formatDistanceToNow(page.updatedAt)}</span>
          </div>
        )}

        {page.createdAt && (
          <div className="flex items-center gap-1">
            <FileText className="h-4 w-4" />
            <span>Created {formatDistanceToNow(page.createdAt)}</span>
          </div>
        )}

        {page.likerCount !== undefined && page.likerCount > 0 && (
          <div className="flex items-center gap-1">
            <span>{page.likerCount} likes</span>
          </div>
        )}

        {page.seenUsersCount !== undefined && page.seenUsersCount > 0 && (
          <div className="flex items-center gap-1">
            <User className="h-4 w-4" />
            <span>{page.seenUsersCount} views</span>
          </div>
        )}
      </div>

      <RenameDialog page={page} open={isRenameOpen} onOpenChange={setIsRenameOpen} />
    </div>
  );
}
