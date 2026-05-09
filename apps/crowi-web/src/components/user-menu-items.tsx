'use client';

import Link from 'next/link';
import { Bookmark, FileText, Settings, Trash2, User } from 'lucide-react';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { m } from '@paraglide/messages.js';

interface UserMenuItemsProps {
  username: string;
}

export function UserMenuItems({ username }: UserMenuItemsProps) {
  return (
    <>
      <DropdownMenuItem asChild>
        <Link href={`/user/${username}`}>
          <User className="h-4 w-4 mr-2" />
          {m['header.user_dropdown_my_page']()}
        </Link>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <Link href="/me">
          <Settings className="h-4 w-4 mr-2" />
          {m['header.user_dropdown_settings']()}
        </Link>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <Link href={`/user/${username}/bookmarks`}>
          <Bookmark className="h-4 w-4 mr-2" />
          {m['header.user_dropdown_bookmarks']()}
        </Link>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <Link href={`/user/${username}/recent-create`}>
          <FileText className="h-4 w-4 mr-2" />
          {m['header.user_dropdown_created']()}
        </Link>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <Link href="/trash">
          <Trash2 className="h-4 w-4 mr-2" />
          {m['header.user_dropdown_trash']()}
        </Link>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}
