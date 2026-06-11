import { z } from '@hono/zod-openapi';

/**
 * Public application info shared with every authenticated page (header,
 * page title, etc.). Sensitive config never appears here.
 *
 * `title` is `null` when the operator has not set a custom site title
 * (i.e. the value still matches the seed default). Clients can use this
 * to switch between the full Crowi lockup and a `[icon] + custom title`
 * presentation.
 *
 * `confidential` is the optional confidentiality notice text the operator
 * sets in admin (`app:confidential`). It is `null` when unset/empty; when
 * present the web shell renders it as an always-on header banner so the
 * notice shows on screenshots / printouts (corporate IT requirement).
 */
export const AppInfoResponseSchema = z.object({
  title: z.string().nullable(),
  confidential: z.string().nullable(),
});
export type AppInfoResponse = z.infer<typeof AppInfoResponseSchema>;
