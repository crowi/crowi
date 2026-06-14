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
 *
 * `version` is the running Crowi server version (the `@crowi/api` package
 * version). `apiVersion` is the API surface version (currently `"v2"`).
 * `capabilities` is a coarse list of subsystems the server exposes —
 * unconditionally-compiled features plus dynamically-detected ones
 * (e.g. `"search"` only when a search driver is active). Together these
 * three fields are the version-skew / feature-detection signal the
 * `@crowi/cli` end-user CLI reads from this public, unauthenticated
 * endpoint. The CLI parses them leniently: an older server that omits
 * them degrades to a static baseline with version-skew warnings
 * suppressed.
 */
export const AppInfoResponseSchema = z.object({
  title: z.string().nullable(),
  confidential: z.string().nullable(),
  version: z.string(),
  apiVersion: z.string(),
  capabilities: z.array(z.string()),
});
export type AppInfoResponse = z.infer<typeof AppInfoResponseSchema>;
