'use client';

import type { PageWithRevision } from '@crowi/api-contract';
import { PageStatusEnum } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';
import { AlertCircle, Check, Copy, Link2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { buildPageShareUrl } from '@/lib/build-page-share-url';
import { isLinkOnlyGrant } from '@/lib/page-grant';
import { copyFailureMessage, useCopyFeedback } from '@/lib/use-copy-feedback';

interface ShowRestrictedShareBannerOptions {
  isStaleRevision: boolean;
  isDraft: boolean;
}

/**
 * Whether `PageView` should render `RestrictedShareBanner` for the given
 * page. Mirrors the claim endpoint's eligibility (`POST /pages/link-access`,
 * `Page.findPageByIdForSharedLinkAccess`): only a GRANT_RESTRICTED page whose
 * status is published (or missing) can actually be claimed, so a wip /
 * deprecated page must not advertise a share URL that would 403 for the
 * recipient. `isDeleted` isn't checked here — `PageView`'s deleted branch
 * returns before this ever gets called. Co-located with the component (not
 * `lib/page-grant.ts`) since it's the banner's own display rule, not a
 * general-purpose grant predicate.
 */
export function shouldShowRestrictedShareBanner(
  page: Pick<PageWithRevision, 'grant' | 'status'>,
  { isStaleRevision, isDraft }: ShowRestrictedShareBannerOptions,
): boolean {
  return isLinkOnlyGrant(page.grant) && !isStaleRevision && !isDraft && (page.status == null || page.status === PageStatusEnum.PUBLISHED);
}

interface RestrictedShareBannerProps {
  pageId: string;
}

/**
 * Standalone, self-contained banner (same shape as `StaleRevisionBanner`)
 * that `PageView` conditionally renders for GRANT_RESTRICTED pages. Tells
 * the reader — honestly — that sharing the URL below invites the recipient
 * as an editor (not read-only access), and lets them copy it. No dismiss UI
 * (out of scope — see spec).
 */
export function RestrictedShareBanner({ pageId }: RestrictedShareBannerProps) {
  const shareUrl = buildPageShareUrl(pageId);
  const { copied, failed, copy } = useCopyFeedback();

  const label = copied ? m['page.share.copied']() : (copyFailureMessage(failed) ?? m['page.share.copy']());

  return (
    <Alert>
      <Link2 className="h-4 w-4" />
      <AlertTitle>{m['page.share.restricted_banner_title']()}</AlertTitle>
      <AlertDescription className="w-full">
        <p>{m['page.share.restricted_banner_body']()}</p>
        <div className="flex w-full items-center gap-2">
          <Input value={shareUrl} readOnly className="font-mono text-xs h-8 bg-muted/40" onFocus={(e) => e.currentTarget.select()} />
          <Button type="button" variant="outline" size="icon-sm" onClick={() => copy(shareUrl)} aria-label={label} title={label}>
            {copied ? (
              <Check className="h-4 w-4 text-emerald-600" />
            ) : failed ? (
              <AlertCircle className="h-4 w-4 text-destructive" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
