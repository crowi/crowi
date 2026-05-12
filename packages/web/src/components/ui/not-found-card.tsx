'use client';

import type { LucideIcon } from 'lucide-react';
import { AlertCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { m } from '@paraglide/messages.js';

interface NotFoundCardProps {
  title?: string;
  description?: React.ReactNode;
  /** Body / paragraph below the description. */
  body?: React.ReactNode;
  /** Icon to render in the header. Defaults to AlertCircle (muted). */
  icon?: LucideIcon;
  /** Tailwind text color for the icon. Defaults to text-muted-foreground. */
  iconClassName?: string;
  /** Action area (typically a row of buttons). */
  actions?: React.ReactNode;
}

/**
 * Standard "X not found" card. The heavy variant (with icon swap and
 * description containing JSX) is used in page-view's "Page Not Found ->
 * create" flow; the light variant is used by id-redirector / page-history.
 */
export function NotFoundCard({ title, description, body, icon: Icon = AlertCircle, iconClassName = 'text-muted-foreground', actions }: NotFoundCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Icon className={`h-5 w-5 ${iconClassName}`} />
          <CardTitle>{title ?? m['common.not_found']()}</CardTitle>
        </div>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        {body && <p className="text-muted-foreground mb-4">{body}</p>}
        {actions}
      </CardContent>
    </Card>
  );
}
