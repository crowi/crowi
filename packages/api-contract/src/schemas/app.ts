import { z } from 'zod';

/**
 * Public application info shared with every authenticated page (header,
 * page title, etc.). Sensitive config never appears here.
 *
 * `title` is `null` when the operator has not set a custom site title
 * (i.e. the value still matches the seed default). Clients can use this
 * to switch between the full Crowi lockup and a `[icon] + custom title`
 * presentation.
 */
export const AppInfoResponseSchema = z.object({
  title: z.string().nullable(),
});
export type AppInfoResponse = z.infer<typeof AppInfoResponseSchema>;
