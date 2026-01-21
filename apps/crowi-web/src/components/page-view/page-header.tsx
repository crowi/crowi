'use client';

import Link from 'next/link';
import { formatDistanceToNow } from '@/lib/date-utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Bookmark, Clock, User, Lock, FileText, Edit2 } from 'lucide-react';
import type { PageWithRevision } from '@crowi/api-contract';
import { PageGrantEnum } from '@crowi/api-contract';

interface PageHeaderProps {
  page: PageWithRevision;
  onEdit?: () => void;
}

export function PageHeader({ page, onEdit }: PageHeaderProps) {
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

  // Get breadcrumb from path
  const getBreadcrumb = (path: string): { path: string; name: string }[] => {
    if (path === '/') return [];
    const segments = path.split('/').filter(Boolean);
    const breadcrumb: { path: string; name: string }[] = [];

    segments.slice(0, -1).forEach((segment, index) => {
      const segmentPath = '/' + segments.slice(0, index + 1).join('/') + '/';
      breadcrumb.push({ path: segmentPath, name: segment });
    });

    return breadcrumb;
  };

  const breadcrumb = getBreadcrumb(page.path);
  const pageTitle = getPageTitle(page.path);

  return (
    <div className="border-b pb-4 mb-6">
      {/* Breadcrumb */}
      {breadcrumb.length > 0 && (
        <nav className="flex items-center gap-1 text-sm text-muted-foreground mb-2">
          <Link href="/" className="hover:text-foreground transition-colors">
            Home
          </Link>
          {breadcrumb.map((item) => (
            <span key={item.path} className="flex items-center gap-1">
              <span>/</span>
              <Link href={item.path} className="hover:text-foreground transition-colors">
                {item.name}
              </Link>
            </span>
          ))}
          <span>/</span>
        </nav>
      )}

      {/* Title and actions */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold truncate">{pageTitle}</h1>
            {isPrivate && (
              <Lock className="h-5 w-5 text-muted-foreground flex-shrink-0" aria-label="Private page" />
            )}
          </div>
          <p className="text-muted-foreground text-sm mt-1 truncate">{page.path}</p>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <Button variant="outline" size="sm" disabled>
            <Bookmark className="h-4 w-4 mr-1" />
            Bookmark
          </Button>
          {onEdit && (
            <Button variant="default" size="sm" onClick={onEdit}>
              <Edit2 className="h-4 w-4 mr-1" />
              Edit
            </Button>
          )}
        </div>
      </div>

      {/* Meta information */}
      <div className="flex flex-wrap items-center gap-4 mt-4 text-sm text-muted-foreground">
        {displayUser && (
          <div className="flex items-center gap-2">
            <Avatar className="h-6 w-6">
              <AvatarImage src={displayUser.image || undefined} alt={displayUser.name} />
              <AvatarFallback className="bg-primary/10 text-primary text-xs">
                {displayUser.name.charAt(0).toUpperCase()}
              </AvatarFallback>
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
    </div>
  );
}
