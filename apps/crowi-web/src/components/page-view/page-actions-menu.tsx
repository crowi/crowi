'use client';

import { useState } from 'react';
import { MoreHorizontal, MoveRight, Trash2 } from 'lucide-react';
import type { PageWithRevision } from '@crowi/api-contract';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { DeletePageDialog } from './delete-page-dialog';
import { RenameDialog } from './rename-dialog';

interface PageActionsMenuProps {
  page: PageWithRevision;
}

/**
 * Overflow menu (...) for secondary page actions (Rename, Delete).
 * Primary actions (Bookmark, Edit) stay as visible buttons in PageHeader.
 */
export function PageActionsMenu({ page }: PageActionsMenuProps) {
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" aria-label="More actions">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setIsRenameOpen(true)}>
            <MoveRight className="h-4 w-4 mr-2" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setIsDeleteOpen(true)} className="text-red-600 focus:text-red-600">
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameDialog page={page} open={isRenameOpen} onOpenChange={setIsRenameOpen} />
      <DeletePageDialog pageId={page._id} pagePath={page.path} revisionId={page.revision?._id} open={isDeleteOpen} onOpenChange={setIsDeleteOpen} />
    </>
  );
}
