import { PageGrantEnum } from '@crowi/api-contract';

/**
 * "Private" in this codebase means OWNER (creator only) or SPECIFIED
 * (an explicit allow-list). RESTRICTED (link-knowing) sits between
 * public and private and is not considered private — use
 * `isLinkOnlyGrant` for that.
 */
export function isPrivateGrant(grant: number | undefined | null): boolean {
  return grant === PageGrantEnum.OWNER || grant === PageGrantEnum.SPECIFIED;
}

/** Link-only sharing — anyone with the URL, no allow-list. */
export function isLinkOnlyGrant(grant: number | undefined | null): boolean {
  return grant === PageGrantEnum.RESTRICTED;
}
