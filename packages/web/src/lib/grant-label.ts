import { PageGrantEnum } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

/** Complete state labels; grant pickers and chips intentionally expose only subsets. */
export function grantLabel(grant: number | undefined): string | null {
  switch (grant) {
    case PageGrantEnum.PUBLIC:
      return m['page.grant_chip_public']();
    case PageGrantEnum.RESTRICTED:
      return m['page.grant_chip_restricted']();
    case PageGrantEnum.SPECIFIED:
      return m['page.grant_chip_specified']();
    case PageGrantEnum.OWNER:
      return m['page.grant_chip_owner']();
    default:
      return null;
  }
}
